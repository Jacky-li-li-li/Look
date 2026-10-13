/** 会话思考等级（Look 自有定义，与 pi-ai ModelThinkingLevel 取值一致）。独立成文件，供 dto/events 直接引用，避免经 types.ts 桶文件形成循环依赖。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
