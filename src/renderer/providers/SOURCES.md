# Provider Icons — Sources

Icons for the AI providers shown on the Settings → API Keys page.

## Source

- **Library**: [Lobe Icons](https://github.com/lobehub/lobe-icons) (npm: `@lobehub/icons-static-svg`)
- **Version**: 1.91.0
- **License**: MIT
- **Upstream**: https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-1.91.0.tgz

Lobe Icons is a curated set of single-color SVG path icons for AI / LLM brands, maintained by the LobeHub community (same project as the LobeChat AI app). It is the icon source credited by [Proma](https://github.com/proma-ai/Proma), a comparable Electron desktop client.

## Color model

Every Lobe Icon SVG uses `fill="currentColor"` (single-color path). The actual rendered color is controlled by the parent element's CSS `color` — so icons automatically follow Look's theme (light/dark) without per-icon dark variants.

## Mapping (pi SDK KnownProvider id → Lobe Icons source file)

| `amazon-bedrock` | `bedrock.svg` |
| `anthropic` | `claude.svg` |
| `google` | `gemini.svg` |
| `google-vertex` | `vertexai.svg` |
| `openai` | `openai.svg` |
| `azure-openai-responses` | `azure.svg` |
| `openai-codex` | `codex.svg` |
| `deepseek` | `deepseek.svg` |
| `github-copilot` | `githubcopilot.svg` |
| `xai` | `xai.svg` |
| `groq` | `groq.svg` |
| `cerebras` | `cerebras.svg` |
| `openrouter` | `openrouter.svg` |
| `vercel-ai-gateway` | `vercel.svg` |
| `zai` | `zai.svg` |
| `mistral` | `mistral.svg` |
| `minimax` | `minimax.svg` |
| `moonshotai` | `moonshotai.svg` |
| `huggingface` | `huggingface.svg` |
| `fireworks` | `fireworks.svg` |
| `together` | `together.svg` |
| `opencode` | `opencode.svg` |
| `kimi-coding` | `kimi.svg` |
| `cloudflare-workers-ai` | `cloudflare-workers-ai.svg` |
| `cloudflare-ai-gateway` | `cloudflare-ai-gateway.svg` |
| `xiaomi` | `xiaomi.svg` |

## Notes

- **Region / plan variants** (`minimax-cn`, `moonshotai-cn`, all `xiaomi-token-plan-*`, `opencode-go`) are normalized to the parent brand ID at runtime by `ProviderIcon.tsx` and share the parent SVG. Only the API endpoint differs; the brand identity is the same.
- `openai-codex` uses the Codex-specific icon (separate from the OpenAI brand mark) to signal "this is the Codex product line".
- `amazon-bedrock` uses the Bedrock icon; the underlying model vendors (Anthropic, Meta, Mistral, etc.) are not separately branded.
- `xai` uses the XAI / Grok mark.

## Regenerating

To refresh icons (e.g. after a Lobe Icons release):

```bash
# Download latest static SVG tarball
curl -sL https://registry.npmjs.org/@lobehub/icons-static-svg/-/icons-static-svg-${VERSION}.tgz \
  -o /tmp/icons-static-svg.tgz
mkdir -p /tmp/icons-static-svg && tar -xzf /tmp/icons-static-svg.tgz -C /tmp/icons-static-svg

# Copy the updated SVGs into this directory, keeping the pi SDK KnownProvider id as
# the basename. Region / plan variants that share a parent brand should be mapped in
# `src/renderer/components/ProviderIcon.tsx` instead of adding duplicate SVG files.
```
