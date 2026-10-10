import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** 会话思考等级（pi-ai ModelThinkingLevel 别名）。独立成文件，供 dto/events 直接引用，避免经 types.ts 桶文件形成循环依赖。 */
export type ThinkingLevel = ModelThinkingLevel;
