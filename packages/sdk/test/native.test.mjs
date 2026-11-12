import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Runtime } from "../dist/daemon/harness.js";
import { Activities } from "../dist/daemon/activities.js";

test("native conversations, extension tools, flat committed activities, deduplication, forks and stopped reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pid-native-"));
  const extensions = join(directory, ".pid", "extensions");
  await mkdir(extensions, { recursive: true });
  await writeFile(
    join(extensions, "echo.ts"),
    `import { defineExtension } from "@earendil-works/pi-durable"; export default defineExtension({ name: "test", tools: [{ name: "echo", description: "Echo input", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, execute: async (args: any) => ({ output: [{type:"text", text:args.text}] }) }] });`,
  );
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking("visible reasoning"),
        fauxText("Checking"),
        fauxToolCall("echo", { text: "tool output" }, { id: "call-1" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Finished"),
  ]);
  const events = [];
  const activities = new Activities(
    (activity) => events.push(activity),
    () => assert.fail("unexpected overflow"),
  );
  const spec = { cwd: directory, desired: "running" };
  const file = join(directory, "session.sqlite");
  let runtime;
  try {
    runtime = await Runtime.open(file, spec, models, { activities });
    const conversation = await runtime.create(spec, { model: "faux/faux-1" });
    assert.equal(typeof conversation.id, "number");
    const first = await runtime.send(conversation.id, "hello", {
      requestId: "native-1",
      wait: true,
    });
    assert.equal(first.settlement.status, "done");
    const duplicate = await runtime.send(conversation.id, "hello", {
      requestId: "native-1",
      wait: true,
    });
    assert.equal(first.submissionId, duplicate.submissionId);
    assert.equal(faux.state.callCount, 2);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "user_message",
        "thinking",
        "assistant_message",
        "tool_call",
        "tool_result",
        "assistant_message",
      ],
    );
    assert.equal(
      events.find((event) => event.type === "tool_result").text,
      "tool output",
    );
    for (const event of events) {
      assert.equal(event.status, undefined);
      assert.equal(event.data, undefined);
      assert.equal(event.content, undefined);
    }
    const fork = await runtime.create(spec, { fork: conversation.id });
    assert.notEqual(fork.id, conversation.id);
    assert.equal(fork.model, conversation.model);
    assert.equal(fork.parent.conversationId, conversation.id);
    const firstPage = await runtime.list(1);
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.next);
    const nextPage = await runtime.list(1, firstPage.next);
    assert.equal(nextPage.items.length, 1);
    assert.notEqual(firstPage.items[0].id, nextPage.items[0].id);
    await runtime.close();
    runtime = undefined;
    runtime = await Runtime.open(file, spec, models, { readOnly: true });
    assert.equal((await runtime.list()).items.length, 2);
    assert.throws(() => runtime.resume(), /read.only/i);
    assert.equal(
      (await runtime.native.inspect(BACKGROUND_CONTEXT)).scheduling,
      "paused",
    );
    assert.equal(faux.state.callCount, 2);
    await runtime.close();
    runtime = undefined;
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native nested calls, image parts, truncation and redacted thinking produce only flat supported activity fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pid-activity-"));
  await mkdir(join(directory, ".pid", "extensions"), { recursive: true });
  await writeFile(
    join(directory, ".pid", "extensions", "nested.mjs"),
    `
export default {name:"nested", tools:[
  {name:"outer",description:"Call another tool",parameters:{type:"object"},execute:async(args,api,context)=>{
    await api.executeTool("picture",{},context,{key:"picture"});
    return {output:[{type:"text",text:"outer complete"}]};
  }},
  {name:"picture",description:"Return an image",parameters:{type:"object"},callers:["tools"],execute:async()=>({
    output:[{type:"text",text:"caption"},{type:"image",mimeType:"image/png",data:"aW1hZ2U="}],
    diagnostics:[{severity:"warn",code:"output_truncated",message:"Output was truncated"}]
  })}
]};`,
  );
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "thinking",
          thinking: "DO_NOT_EXPORT",
          redacted: true,
          thinkingSignature: "private signature",
        },
        fauxThinking("readable"),
        fauxToolCall("outer", {}, { id: "parent" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const events = [];
  const activities = new Activities(
    (event) => events.push(event),
    () => assert.fail("overflow"),
  );
  let runtime;
  try {
    const spec = { cwd: directory, desired: "running" };
    runtime = await Runtime.open(
      join(directory, "session.sqlite"),
      spec,
      models,
      { activities },
    );
    const summary = await runtime.create(spec, { model: "faux/faux-1" });
    const conversation = await runtime.conversation(summary.id);
    const submission = await conversation.submit(
      {
        type: "input",
        content: [
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/png", data: "dXNlcg==" },
        ],
      },
      BACKGROUND_CONTEXT,
    );
    assert.equal((await submission.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.ok(!JSON.stringify(events).includes("DO_NOT_EXPORT"));
    assert.ok(!JSON.stringify(events).includes("private signature"));
    assert.equal(events.filter((event) => event.type === "thinking").length, 1);
    assert.ok(
      events.some(
        (event) =>
          event.type === "image" &&
          event.source === "user" &&
          event.index === 1,
      ),
    );
    const nestedCall = events.find(
      (event) => event.type === "tool_call" && event.parentCallId === "parent",
    );
    assert.equal(nestedCall.callId, "parent/picture");
    const imageIndex = events.findIndex(
      (event) => event.type === "image" && event.callId === nestedCall.callId,
    );
    const resultIndex = events.findIndex(
      (event) =>
        event.type === "tool_result" && event.callId === nestedCall.callId,
    );
    assert.ok(imageIndex >= 0 && resultIndex > imageIndex);
    assert.equal(events[resultIndex].text, "caption");
    assert.equal(events[resultIndex].truncated, true);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "tool_result" && event.callId === nestedCall.callId,
      ).length,
      1,
    );
    assert.deepEqual(Object.keys(events[resultIndex]).sort(), [
      "callId",
      "conversationId",
      "text",
      "truncated",
      "type",
    ]);
    assert.equal(
      events.filter((event) => event.type === "tool_result").length,
      2,
    );
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
