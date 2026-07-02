// @vitest-environment jsdom
import MarkdownRender from "markstream-react";
import { render } from "@testing-library/react";
import { it } from "vitest";

function Chip({ node }: any) {
  return <span data-chip={node.attrs?.find(([k]: any) => k === "name")?.[1]}>CHIP</span>;
}

it("debug", () => {
  const { container } = render(
    <MarkdownRender
      content='Use <skill-tag name="search"></skill-tag> here'
      final
      parseOptions={{ streamParse: false }}
      customHtmlTags={["skill-tag"]}
      streamingComponents={{ "skill-tag": Chip }}
    />
  );
  console.log(container.innerHTML);
});
