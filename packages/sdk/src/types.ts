import type {
  CompactionResult,
  SettledSubmissionRecord,
  TaskOutcome,
} from "@earendil-works/pi-durable";
export type HarnessRef = string;
export type DesiredState = "running" | "stopped" | "absent";
export type HarnessSpec = {
  cwd: string;
  name?: string;
  desired: DesiredState;
};
export type ErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
};
export type HarnessInfo = HarnessSpec & {
  id: string;
  actual:
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "destroying"
    | "error"
    | "absent";
  error?: ErrorInfo;
};
export type ConversationSummary = {
  id: number;
  model?: string;
  parent?: {
    conversationId: number;
    at: number;
  };
};
export type ConversationPage = {
  items: ConversationSummary[];
  next?: string;
};
export type ConversationOptions =
  | {
      model: string;
      fork?: never;
      at?: never;
    }
  | {
      fork: number;
      at?: number;
      model?: string;
    };
export type SendOptions = {
  requestId?: string;
  whenBusy?: "follow-up" | "steer" | "reject";
  whenIdle?: "run" | "reject";
  wait?: boolean;
};
export type SendReceipt = {
  submissionId: number;
  requestId: string;
  settlement?: SettledSubmissionRecord;
};
export type CompactReceipt = {
  taskId: number;
  outcome?: TaskOutcome<CompactionResult>;
  settlement?: SettledSubmissionRecord;
};
export type DaemonInfo = {
  stateDir: string;
  pid: number;
  instanceId: string;
  recovering: boolean;
  errors: {
    id: string;
    error: ErrorInfo;
  }[];
};
export type Activity =
  | {
      type: "thinking" | "assistant_message" | "user_message";
      conversationId: number;
      entryId: number;
      index: number;
      text: string;
    }
  | {
      type: "image";
      conversationId: number;
      entryId?: number;
      callId?: string;
      index: number;
      source: "user" | "assistant" | "tool";
      mimeType: string;
      base64: string;
    }
  | {
      type: "tool_call";
      conversationId: number;
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      parentCallId?: string;
    }
  | {
      type: "tool_result";
      conversationId: number;
      callId: string;
      text?: string;
      error?: ErrorInfo;
      truncated?: true;
    }
  | {
      type: "error";
      conversationId: number;
      code: string;
      message: string;
      taskId?: number;
    };
export interface ActivitySubscription extends AsyncIterable<Activity> {
  close(): Promise<void>;
}
export type AuthEvent =
  | {
      type: "info" | "progress";
      message: string;
      links?: readonly {
        url: string;
        label?: string;
      }[];
    }
  | {
      type: "auth_url";
      url: string;
      instructions?: string;
    }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };
export type AuthPrompt =
  | {
      type: "text" | "secret" | "manual_code";
      message: string;
      placeholder?: string;
      signal?: AbortSignal;
    }
  | {
      type: "select";
      message: string;
      options: readonly {
        id: string;
        label: string;
        description?: string;
      }[];
      signal?: AbortSignal;
    };
export interface AuthInteraction {
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
  signal?: AbortSignal;
}
export interface Client {
  harnesses: {
    start(
      ref: HarnessRef,
      options?: {
        name?: string;
      },
    ): Promise<HarnessInfo>;
    list(): Promise<HarnessInfo[]>;
    stop(ref: HarnessRef): Promise<HarnessInfo>;
    destroy(ref: HarnessRef): Promise<HarnessInfo>;
  };
  conversations: {
    create(
      ref: HarnessRef,
      options: ConversationOptions,
    ): Promise<ConversationSummary>;
    list(
      ref: HarnessRef,
      options?: {
        limit?: number;
        cursor?: string;
      },
    ): Promise<ConversationPage>;
  };
  send(
    ref: HarnessRef,
    conversationId: number,
    message: string,
    options?: SendOptions,
  ): Promise<SendReceipt>;
  watch(
    ref: HarnessRef,
    options?: {
      conversationId?: number;
    },
  ): Promise<ActivitySubscription>;
  compact(
    ref: HarnessRef,
    conversationId: number,
    options?: {
      instructions?: string;
      wait?: boolean;
    },
  ): Promise<CompactReceipt>;
  abort(
    ref: HarnessRef,
    conversationId: number,
    options?: {
      background?: boolean;
    },
  ): Promise<{
    aborted: true;
  }>;
  auth: {
    login(
      provider: string,
      interaction: AuthInteraction,
    ): Promise<{
      provider: string;
      type: string;
    }>;
  };
  close(): Promise<void>;
}
