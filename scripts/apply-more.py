#!/usr/bin/env python3
"""Apply remaining App.tsx changes: message_end, tool_execution, agent_end, ChatPanel prop."""
with open("src/renderer/App.tsx", encoding="utf-8") as f:
    content = f.read()

# 6. message_end handler - preserve toolCall runtime state
old_msg_end = '\t\t\tcase "agent:message_end": {\n' + \
    "\t\t\t\t// Final state: replace streaming message with the completed one.\n" + \
    "\t\t\t\tconst finalMsg = event.message as any;\n" + \
    "\t\t\t\tsetMessages((prev) => {\n" + \
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n" + \
    "\t\t\t\t\tlet idx = msgs.length - 1;\n" + \
    "\t\t\t\t\tfor (let i = msgs.length - 1; i >= 0; i--)\n" + \
    "\t\t\t\t\t\tif (msgs[i].isStreaming) {\n" + \
    "\t\t\t\t\t\t\tidx = i;\n" + \
    "\t\t\t\t\t\t\tbreak;\n" + \
    "\t\t\t\t\t\t}\n" + \
    "\t\t\t\t\tif (idx < 0) return prev;\n" + \
    "\t\t\t\t\tconst blocks: PiContentBlock[] = Array.isArray(finalMsg.content)\n" + \
    "\t\t\t\t\t\t? finalMsg.content.map(sdkBlockToPiBlock)\n" + \
    "\t\t\t\t\t\t: msgs[idx].contentBlocks;\n" + \
    "\t\t\t\t\tmsgs[idx] = {\n" + \
    "\t\t\t\t\t\t...msgs[idx],\n" + \
    "\t\t\t\t\t\tcontentBlocks: blocks,\n" + \
    "\t\t\t\t\t\tisStreaming: false,\n" + \
    "\t\t\t\t\t\ttimestamp: finalMsg.timestamp ?? msgs[idx].timestamp,\n" + \
    "\t\t\t\t\t};\n" + \
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n" + \
    "\t\t\t\t});\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

new_msg_end = '\t\t\tcase "agent:message_end": {\n' + \
    "\t\t\t\t// Final state: replace streaming message with the completed one.\n" + \
    "\t\t\t\t// Preserve toolCall block runtime state (status/result/isError) that\n" + \
    "\t\t\t\t// was baked in by tool_execution_end \u2014 the SDK's content blocks don't\n" + \
    "\t\t\t\t// carry execution state and would clobber it back to \"pending\"/\"\".\n" + \
    "\t\t\t\tconst finalMsg = event.message as any;\n" + \
    "\t\t\t\tsetMessages((prev) => {\n" + \
    "\t\t\t\t\tconst msgs = [...(prev[event.agentId] ?? [])];\n" + \
    "\t\t\t\t\tlet idx = msgs.length - 1;\n" + \
    "\t\t\t\t\tfor (let i = msgs.length - 1; i >= 0; i--)\n" + \
    "\t\t\t\t\t\tif (msgs[i].isStreaming) {\n" + \
    "\t\t\t\t\t\t\tidx = i;\n" + \
    "\t\t\t\t\t\t\tbreak;\n" + \
    "\t\t\t\t\t\t}\n" + \
    "\t\t\t\t\tif (idx < 0) return prev;\n" + \
    "\t\t\t\t\tconst oldBlocks = msgs[idx].contentBlocks;\n" + \
    "\t\t\t\t\tconst blocks: PiContentBlock[] = Array.isArray(finalMsg.content)\n" + \
    "\t\t\t\t\t\t? finalMsg.content.map((b: any): PiContentBlock => {\n" + \
    "\t\t\t\t\t\t\t\tif (b.type !== \"toolCall\")\n" + \
    "\t\t\t\t\t\t\t\t\treturn { ...b, active: false } as PiTextBlock | PiThinkingBlock;\n" + \
    "\t\t\t\t\t\t\t\tconst oldBlock = oldBlocks.find(\n" + \
    "\t\t\t\t\t\t\t\t\t(ob) => ob.type === \"toolCall\" && (ob as PiToolCallBlock).id === b.id,\n" + \
    "\t\t\t\t\t\t\t\t) as PiToolCallBlock | undefined;\n" + \
    "\t\t\t\t\t\t\t\treturn {\n" + \
    "\t\t\t\t\t\t\t\t\ttype: \"toolCall\",\n" + \
    "\t\t\t\t\t\t\t\t\tid: b.id ?? \"\",\n" + \
    "\t\t\t\t\t\t\t\t\tname: b.name ?? \"unknown\",\n" + \
    "\t\t\t\t\t\t\t\t\targuments: b.arguments ?? {},\n" + \
    "\t\t\t\t\t\t\t\t\tstatus: oldBlock?.status ?? \"pending\",\n" + \
    "\t\t\t\t\t\t\t\t\tresult: oldBlock?.result ?? \"\",\n" + \
    "\t\t\t\t\t\t\t\t\tisError: oldBlock?.isError ?? false,\n" + \
    "\t\t\t\t\t\t\t\t} satisfies PiToolCallBlock;\n" + \
    "\t\t\t\t\t\t\t})\n" + \
    "\t\t\t\t\t\t: oldBlocks;\n" + \
    "\t\t\t\t\tmsgs[idx] = {\n" + \
    "\t\t\t\t\t\t...msgs[idx],\n" + \
    "\t\t\t\t\t\tcontentBlocks: blocks,\n" + \
    "\t\t\t\t\t\tisStreaming: false,\n" + \
    "\t\t\t\t\t\ttimestamp: finalMsg.timestamp ?? msgs[idx].timestamp,\n" + \
    "\t\t\t\t\t};\n" + \
    "\t\t\t\t\treturn { ...prev, [event.agentId]: msgs };\n" + \
    "\t\t\t\t});\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

assert old_msg_end in content, "message_end not found!"
content = content.replace(old_msg_end, new_msg_end)
print("✓ message_end")

# 7. tool_execution_start + tool_execution_update + tool_execution_end
old_tool_exec = '\t\t\tcase "agent:tool_execution_start":\n' + \
    '\t\t\tcase "agent:tool_execution_update":\n' + \
    '\t\t\tcase "agent:tool_execution_end": {\n' + \
    "\t\t\t\tconst resultStr =\n" + \
    "\t\t\t\t\ttypeof event.result === \"string\"\n" + \
    "\t\t\t\t\t\t? event.result\n" + \
    "\t\t\t\t\t\t: ((event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result));\n" + \
    "\t\t\t\tsetToolStates((prev) => {\n" + \
    "\t\t\t\t\tconst byAgent = { ...(prev[event.agentId] ?? {}) };\n" + \
    "\t\t\t\t\tconst current = byAgent[event.toolCallId] ?? { status: \"pending\", result: \"\", isError: false };\n" + \
    "\n" + \
    "\t\t\t\t\tif (event.type === \"agent:tool_execution_start\") {\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = { ...current, status: \"running\" };\n" + \
    "\t\t\t\t\t} else if (event.type === \"agent:tool_execution_update\") {\n" + \
    "\t\t\t\t\t\tconst partial = (event.partialResult as any)?.content?.[0]?.text ?? \"\";\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = {\n" + \
    "\t\t\t\t\t\t\t...current,\n" + \
    "\t\t\t\t\t\t\tresult: (current.result ?? \"\") + partial,\n" + \
    "\t\t\t\t\t\t};\n" + \
    "\t\t\t\t\t} else {\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = {\n" + \
    "\t\t\t\t\t\t\tstatus: event.isError ? \"error\" : \"success\",\n" + \
    "\t\t\t\t\t\t\tresult: resultStr,\n" + \
    "\t\t\t\t\t\t\tisError: event.isError,\n" + \
    "\t\t\t\t\t\t};\n" + \
    "\t\t\t\t\t}\n" + \
    "\t\t\t\t\treturn { ...prev, [event.agentId]: byAgent };\n" + \
    "\t\t\t\t});\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

new_tool_exec = '\t\t\tcase "agent:tool_execution_start":\n' + \
    '\t\t\tcase "agent:tool_execution_update":\n' + \
    '\t\t\tcase "agent:tool_execution_end": {\n' + \
    "\t\t\t\t// Compute resultStr before state updates (needed by both toolStates and messages)\n" + \
    "\t\t\t\tconst execResultStr =\n" + \
    "\t\t\t\t\tevent.type === \"agent:tool_execution_end\"\n" + \
    "\t\t\t\t\t\t? typeof event.result === \"string\"\n" + \
    "\t\t\t\t\t\t\t? event.result\n" + \
    "\t\t\t\t\t\t\t: ((event.result as any)?.content?.[0]?.text ?? JSON.stringify(event.result))\n" + \
    "\t\t\t\t\t\t: null;\n" + \
    "\t\t\t\tconst execFinalStatus =\n" + \
    "\t\t\t\t\tevent.type === \"agent:tool_execution_end\"\n" + \
    "\t\t\t\t\t\t? event.isError\n" + \
    "\t\t\t\t\t\t\t? \"error\"\n" + \
    "\t\t\t\t\t\t\t: \"success\"\n" + \
    "\t\t\t\t\t\t: null;\n" + \
    "\n" + \
    "\t\t\t\tsetToolStates((prev) => {\n" + \
    "\t\t\t\t\tconst byAgent = { ...(prev[event.agentId] ?? {}) };\n" + \
    "\t\t\t\t\tconst current = byAgent[event.toolCallId] ?? { status: \"pending\", result: \"\", isError: false };\n" + \
    "\n" + \
    "\t\t\t\t\tif (event.type === \"agent:tool_execution_start\") {\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = { ...current, status: \"running\" };\n" + \
    "\t\t\t\t\t} else if (event.type === \"agent:tool_execution_update\") {\n" + \
    "\t\t\t\t\t\tconst partial = (event.partialResult as any)?.content?.[0]?.text ?? \"\";\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = {\n" + \
    "\t\t\t\t\t\t\t...current,\n" + \
    "\t\t\t\t\t\t\tresult: (current.result ?? \"\") + partial,\n" + \
    "\t\t\t\t\t\t};\n" + \
    "\t\t\t\t\t} else {\n" + \
    "\t\t\t\t\t\tbyAgent[event.toolCallId] = {\n" + \
    "\t\t\t\t\t\t\tstatus: execFinalStatus!,\n" + \
    "\t\t\t\t\t\t\tresult: execResultStr ?? \"\",\n" + \
    "\t\t\t\t\t\t\tisError: event.isError,\n" + \
    "\t\t\t\t\t\t};\n" + \
    "\t\t\t\t\t}\n" + \
    "\t\t\t\t\treturn { ...prev, [event.agentId]: byAgent };\n" + \
    "\t\t\t\t});\n" + \
    "\n" + \
    "\t\t\t\t// SDK-aligned: bake final execution state directly into contentBlocks\n" + \
    "\t\t\t\t// so it survives message_end / agent_end cleanup.\n" + \
    "\t\t\t\tif (event.type === \"agent:tool_execution_end\") {\n" + \
    "\t\t\t\t\tsetMessages((prev): Record<string, PiMessage[]> => {\n" + \
    "\t\t\t\t\t\tconst msgs = prev[event.agentId];\n" + \
    "\t\t\t\t\t\tif (!msgs) return prev;\n" + \
    "\t\t\t\t\t\tconst newMsgs: PiMessage[] = msgs.map((msg) => {\n" + \
    "\t\t\t\t\t\t\tif (!msg.isStreaming || msg.role !== \"assistant\") return msg;\n" + \
    "\t\t\t\t\t\t\tconst newBlocks = msg.contentBlocks.map((b) => {\n" + \
    "\t\t\t\t\t\t\t\tif (b.type !== \"toolCall\") return b;\n" + \
    "\t\t\t\t\t\t\t\tconst tc = b as PiToolCallBlock;\n" + \
    "\t\t\t\t\t\t\t\tif (tc.id !== event.toolCallId) return b;\n" + \
    "\t\t\t\t\t\t\t\treturn {\n" + \
    "\t\t\t\t\t\t\t\t\t...tc,\n" + \
    "\t\t\t\t\t\t\t\t\tstatus: execFinalStatus!,\n" + \
    "\t\t\t\t\t\t\t\t\tresult: execResultStr ?? \"\",\n" + \
    "\t\t\t\t\t\t\t\t\tisError: event.isError,\n" + \
    "\t\t\t\t\t\t\t\t} as PiToolCallBlock;\n" + \
    "\t\t\t\t\t\t\t});\n" + \
    "\t\t\t\t\t\t\tif (newBlocks === msg.contentBlocks) return msg;\n" + \
    "\t\t\t\t\t\t\treturn { ...msg, contentBlocks: newBlocks };\n" + \
    "\t\t\t\t\t\t});\n" + \
    "\t\t\t\t\t\treturn { ...prev, [event.agentId]: newMsgs };\n" + \
    "\t\t\t\t\t});\n" + \
    "\t\t\t\t}\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

assert old_tool_exec in content, "tool_exec not found!"
content = content.replace(old_tool_exec, new_tool_exec)
print("✓ tool_exec handler")

# 8. agent_end - restore cleanup (was removed in previous iteration)
old_agent_end = '\t\t\tcase "agent:agent_end": {\n' + \
    "\t\t\t\t// Clean up toolStates for this agent on agent_end\n" + \
    "\t\t\t\t// (only valid once the tool calls have been fully rendered)\n" + \
    "\t\t\t\t// Tool states are cleaned up incrementally on each tool_execution_end\n" + \
    "\t\t\t\t// so this is just a safety net for any stragglers.\n" + \
    "\t\t\t\tsetToolStates((prev) => {\n" + \
    "\t\t\t\t\tconst next = { ...prev };\n" + \
    "\t\t\t\t\tdelete next[event.agentId];\n" + \
    "\t\t\t\t\treturn next;\n" + \
    "\t\t\t\t});\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

new_agent_end = '\t\t\tcase "agent:agent_end": {\n' + \
    "\t\t\t\t// Safe to clean up toolStates \u2014 final state was baked into\n" + \
    "\t\t\t\t// contentBlocks by tool_execution_end and preserved by message_end.\n" + \
    "\t\t\t\tsetToolStates((prev) => {\n" + \
    "\t\t\t\t\tconst next = { ...prev };\n" + \
    "\t\t\t\t\tdelete next[event.agentId];\n" + \
    "\t\t\t\t\treturn next;\n" + \
    "\t\t\t\t});\n" + \
    "\t\t\t\tbreak;\n" + \
    "\t\t\t}"

assert old_agent_end in content, "agent_end not found!"
content = content.replace(old_agent_end, new_agent_end)
print("✓ agent_end")

with open("src/renderer/App.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("Written final")
