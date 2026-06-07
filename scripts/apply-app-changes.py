#!/usr/bin/env python3
"""Apply all App.tsx changes for SDK alignment."""
import re

with open("src/renderer/App.tsx", encoding="utf-8") as f:
    content = f.read()

# 1. Add ToolExecutionState import
content = content.replace(
    "import type {\n\tAgentInfo,\n\tMainToRendererEvent,\n\tPiContentBlock,\n\tPiMessage,\n\tPiTextBlock,\n\tPiThinkingBlock,\n\tPiToolCallBlock,\n\tThinkingLevel,\n} from \"@shared/types\";",
    "import type {\n\tAgentInfo,\n\tMainToRendererEvent,\n\tPiContentBlock,\n\tPiMessage,\n\tPiTextBlock,\n\tPiThinkingBlock,\n\tPiToolCallBlock,\n\tThinkingLevel,\n\tToolExecutionState,\n} from \"@shared/types\";"
)
print("✓ Import")

# 2. Add sdkBlockToPiBlock before App()
content = content.replace(
    "export default function App() {",
    """/** Shared: convert a raw pi SDK content block to Look's PiContentBlock.
 *  Used by message_start, message_update, and message_end handlers. */
function sdkBlockToPiBlock(b: any): PiContentBlock {
\tif (b.type === "toolCall") {
\t\treturn {
\t\t\ttype: "toolCall",
\t\t\tid: b.id ?? "",
\t\t\tname: b.name ?? "unknown",
\t\t\targuments: b.arguments ?? {},
\t\t\tstatus: b.status ?? (b.result ? (b.isError ? "error" : "success") : "pending"),
\t\t\tresult: b.result ?? "",
\t\t\tisError: b.isError ?? false,
\t\t} satisfies PiToolCallBlock;
\t}
\treturn { ...b, active: false } as PiTextBlock | PiThinkingBlock;
}

export default function App() {"""
)
print("✓ sdkBlockToPiBlock")

# 3. Add toolStates state
content = content.replace(
    "const [queues, setQueues] = useState<Record<string, { steering: string[]; followUp: string[] }>>({});",
    "const [queues, setQueues] = useState<Record<string, { steering: string[]; followUp: string[] }>>({});\n"
    "// Tool execution runtime state: agentId \u2192 toolCallId \u2192 status/result/isError.\n"
    "// Managed by tool_execution_* events; baked into contentBlocks on tool_execution_end.\n"
    "const [toolStates, setToolStates] = useState<Record<string, Record<string, ToolExecutionState>>>({});"
)
print("✓ toolStates")

# 4. message_start handler
content = content.replace(
    '\t\t\tcase "agent:message_start": {\n'
    "\t\t\t\tconst msg = event.message as any; // raw pi SDK message pass-through\n"
    "\t\t\t\tsetMessages((prev) => {\n"
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n"
    "\t\t\t\t\tconst makeContentBlocks = (content: unknown): PiContentBlock[] => {\n"
    "\t\t\t\t\t\tif (Array.isArray(content)) {\n"
    "\t\t\t\t\t\t\treturn content.map((b: any): PiContentBlock => {\n"
    "\t\t\t\t\t\t\t\tif (b.type === \"toolCall\") {\n"
    "\t\t\t\t\t\t\t\t\treturn {\n"
    "\t\t\t\t\t\t\t\t\t\ttype: \"toolCall\",\n"
    "\t\t\t\t\t\t\t\t\t\tid: b.id ?? \"\",\n"
    "\t\t\t\t\t\t\t\t\t\tname: b.name ?? \"unknown\",\n"
    "\t\t\t\t\t\t\t\t\t\targuments: b.arguments ?? {},\n"
    "\t\t\t\t\t\t\t\t\t\tstatus: \"pending\",\n"
    "\t\t\t\t\t\t\t\t\t\tresult: \"\",\n"
    "\t\t\t\t\t\t\t\t\t\tisError: false,\n"
    "\t\t\t\t\t\t\t\t\t} satisfies PiToolCallBlock;\n"
    "\t\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\t\t\treturn { ...b, active: true } as PiTextBlock | PiThinkingBlock;\n"
    "\t\t\t\t\t\t\t});\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\tif (typeof content === \"string\" && content.length > 0) {\n"
    "\t\t\t\t\t\t\treturn [{ type: \"text\", text: content, active: false }];\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\treturn [];\n"
    "\t\t\t\t\t};\n"
    "\t\t\t\t\tconst ui: PiMessage = {\n"
    "\t\t\t\t\t\tid: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,\n"
    "\t\t\t\t\t\tagentId: event.agentId,\n"
    "\t\t\t\t\t\trole: msg.role === \"toolResult\" ? \"tool\" : (msg.role ?? \"assistant\"),\n"
    "\t\t\t\t\t\tcontentBlocks: makeContentBlocks(msg.content),\n"
    "\t\t\t\t\t\ttimestamp: msg.timestamp ?? Date.now(),\n"
    "\t\t\t\t\t\tisStreaming: true,\n"
    "\t\t\t\t\t};\n"
    "\t\t\t\t\tmsgs.push(ui);\n"
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n"
    "\t\t\t\t});\n"
    "\t\t\t\tbreak;\n"
    "\t\t\t}",
    '\t\t\tcase "agent:message_start": {\n'
    "\t\t\t\tconst msg = event.message as any;\n"
    "\t\t\t\tsetMessages((prev) => {\n"
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n"
    "\t\t\t\t\tconst blocks: PiContentBlock[] = Array.isArray(msg.content)\n"
    "\t\t\t\t\t\t? msg.content.map(sdkBlockToPiBlock)\n"
    "\t\t\t\t\t\t: typeof msg.content === \"string\" && msg.content.length > 0\n"
    "\t\t\t\t\t\t\t? [{ type: \"text\", text: msg.content, active: false }]\n"
    "\t\t\t\t\t\t\t: [];\n"
    "\t\t\t\t\tconst ui: PiMessage = {\n"
    "\t\t\t\t\t\tid: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,\n"
    "\t\t\t\t\t\tagentId: event.agentId,\n"
    "\t\t\t\t\t\trole: msg.role === \"toolResult\" ? \"tool\" : (msg.role ?? \"assistant\"),\n"
    "\t\t\t\t\t\tcontentBlocks: blocks,\n"
    "\t\t\t\t\t\ttimestamp: msg.timestamp ?? Date.now(),\n"
    "\t\t\t\t\t\tisStreaming: true,\n"
    "\t\t\t\t\t};\n"
    "\t\t\t\t\tmsgs.push(ui);\n"
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n"
    "\t\t\t\t});\n"
    "\t\t\t\tbreak;\n"
    "\t\t\t}"
)
print("✓ message_start")

# 5. message_update handler
content = content.replace(
    '\t\t\tcase "agent:message_update": {\n'
    "\t\t\t\t// pi's `message_update` carries a delta in `assistantMessageEvent`.\n"
    "\t\t\t\t// We apply it to the matching streaming message's contentBlocks.\n"
    "\t\t\t\tconst evt = event.assistantMessageEvent;\n"
    "\t\t\t\tsetMessages((prev) => {\n"
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n"
    "\t\t\t\t\tconst msgId = (event.message as any)?.id;\n"
    "\t\t\t\t\tlet idx = msgId ? msgs.findIndex((m) => m.id === msgId) : -1;\n"
    "\t\t\t\t\tif (idx < 0) {\n"
    "\t\t\t\t\t\tidx = msgs.length - 1;\n"
    "\t\t\t\t\t\tfor (let i = msgs.length - 1; i >= 0; i--)\n"
    "\t\t\t\t\t\t\tif (msgs[i].isStreaming) {\n"
    "\t\t\t\t\t\t\t\tidx = i;\n"
    "\t\t\t\t\t\t\t\tbreak;\n"
    "\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tif (idx < 0) return prev;\n"
    "\t\t\t\t\tconst blocks = [...msgs[idx].contentBlocks];\n"
    "\t\t\t\t\tif (evt.type === \"text_delta\") {\n"
    "\t\t\t\t\t\tlet block = [...blocks].reverse().find((b) => b.type === \"text\" && b.active === true) as\n"
    "\t\t\t\t\t\t\t| PiTextBlock\n"
    "\t\t\t\t\t\t\t| undefined;\n"
    "\t\t\t\t\t\tif (!block) {\n"
    "\t\t\t\t\t\t\tblock = { type: \"text\", text: \"\", active: true };\n"
    "\t\t\t\t\t\t\tblocks.push(block);\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\tblock.text += evt.delta;\n"
    "\t\t\t\t\t} else if (evt.type === \"thinking_delta\") {\n"
    "\t\t\t\t\t\tlet block = [...blocks].reverse().find((b) => b.type === \"thinking\" && b.active === true) as\n"
    "\t\t\t\t\t\t\t| PiThinkingBlock\n"
    "\t\t\t\t\t\t\t| undefined;\n"
    "\t\t\t\t\t\tif (!block) {\n"
    "\t\t\t\t\t\t\tblock = { type: \"thinking\", thinking: \"\", active: true };\n"
    "\t\t\t\t\t\t\tblocks.push(block);\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t\tblock.thinking += evt.delta;\n"
    "\t\t\t\t\t} else if (evt.type === \"toolcall_end\") {\n"
    "\t\t\t\t\t\tconst tc = (evt as any).toolCall;\n"
    "\t\t\t\t\t\tif (tc) {\n"
    "\t\t\t\t\t\t\tblocks.push({\n"
    "\t\t\t\t\t\t\t\ttype: \"toolCall\",\n"
    "\t\t\t\t\t\t\t\tid: tc.id ?? \"\",\n"
    "\t\t\t\t\t\t\t\tname: tc.name ?? \"unknown\",\n"
    "\t\t\t\t\t\t\t\targuments: tc.arguments ?? {},\n"
    "\t\t\t\t\t\t\t\tstatus: \"pending\",\n"
    "\t\t\t\t\t\t\t\tresult: \"\",\n"
    "\t\t\t\t\t\t\t\tisError: false,\n"
    "\t\t\t\t\t\t\t} satisfies PiToolCallBlock);\n"
    "\t\t\t\t\t\t}\n"
    "\t\t\t\t\t} else if (evt.type === \"text_end\") {\n"
    "\t\t\t\t\t\tfor (const b of blocks) if (b.type === \"text\" && b.active) b.active = false;\n"
    "\t\t\t\t\t} else if (evt.type === \"thinking_end\") {\n"
    "\t\t\t\t\t\tfor (const b of blocks) if (b.type === \"thinking\" && b.active) b.active = false;\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tif (evt.delta || evt.type === \"toolcall_end\" || evt.type === \"text_end\" || evt.type === \"thinking_end\") {\n"
    "\t\t\t\t\t\tmsgs[idx] = { ...msgs[idx], contentBlocks: blocks };\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n"
    "\t\t\t\t});\n"
    "\t\t\t\tbreak;\n"
    "\t\t\t}",
    '\t\t\tcase "agent:message_update": {\n'
    "\t\t\t\t// Use pi SDK's event.message.content snapshot directly instead of\n"
    "\t\t\t\t// manual delta accumulation. The SDK already tracks partial.content\n"
    "\t\t\t\t// internally — we just read the complete state from each update.\n"
    "\t\t\t\tsetMessages((prev) => {\n"
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n"
    "\t\t\t\t\tconst msgId = (event.message as any)?.id;\n"
    "\t\t\t\t\tlet idx = msgId ? msgs.findIndex((m) => m.id === msgId) : -1;\n"
    "\t\t\t\t\tif (idx < 0) {\n"
    "\t\t\t\t\t\tidx = msgs.length - 1;\n"
    "\t\t\t\t\t\tfor (let i = msgs.length - 1; i >= 0; i--)\n"
    "\t\t\t\t\t\t\tif (msgs[i].isStreaming) {\n"
    "\t\t\t\t\t\t\t\tidx = i;\n"
    "\t\t\t\t\t\t\t\tbreak;\n"
    "\t\t\t\t\t\t\t}\n"
    "\t\t\t\t\t}\n"
    "\t\t\t\t\tif (idx < 0) return prev;\n"
    "\t\t\t\t\tconst rawContent = (event.message as any)?.content;\n"
    "\t\t\t\t\tif (!Array.isArray(rawContent)) return prev;\n"
    "\t\t\t\t\tmsgs[idx] = { ...msgs[idx], contentBlocks: rawContent.map(sdkBlockToPiBlock) };\n"
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n"
    "\t\t\t\t});\n"
    "\t\t\t\tbreak;\n"
    "\t\t\t}"
)
print("✓ message_update")

with open("src/renderer/App.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("Written partial")
