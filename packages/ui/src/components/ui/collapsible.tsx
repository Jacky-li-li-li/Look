import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import type * as React from "react";
import { CollapsibleContent } from "./collapsible-content.js";
import { CollapsibleTrigger } from "./collapsible-trigger.js";

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
	return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
