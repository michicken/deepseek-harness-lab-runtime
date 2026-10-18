declare module "@deepseek-ai/cordis" {
  export class Context {
    tools: { register(definition: unknown): void };
    on(event: string, callback: (payload: any) => any): unknown;
    effect(...args: unknown[]): unknown;
  }
  export class Service {
    constructor(ctx: Context, name: string);
  }
}

declare module "@deepseek-ai/dsh-agent" {
  export interface Agent {
    readonly id: string;
    followup(message: unknown): void;
    steer(message: unknown): void;
  }
}

declare module "@deepseek-ai/dsh-llm" {
  export function createUserMessage(value: unknown): unknown;
}

declare module "@deepseek-ai/dsh-tools" {
  export function defineTool(options: {
    execute(args: any, exec: any): any;
    output: { schema?: any; render(args: any, value: any): any };
    [key: string]: any;
  }): any;
}
