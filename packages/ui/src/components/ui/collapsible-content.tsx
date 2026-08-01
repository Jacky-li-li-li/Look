import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import type * as React from "react";

export function CollapsibleContent({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
	return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}
