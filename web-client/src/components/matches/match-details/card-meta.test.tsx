import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CardMeta } from "./card-meta";

describe("CardMeta", () => {
  // Every panel caption routes through this one component, so the panels can no
  // longer drift apart from each other — but they can still drift *together*,
  // away from the grey they shipped with. That is what this pins.
  //
  // `--fg-muted` is `--chalk-500` (#6b7283). `text-muted-foreground` is the
  // tempting design-system token and is wrong: `.fortymm-theme` remaps it to
  // `--chalk-300` (#a9b0c2), a visibly lighter grey. A caption that quietly
  // switched tokens is exactly the regression #218 exists to prevent.
  it("captions in the muted grey, not the lighter design-system token", () => {
    render(<CardMeta>3 MEETINGS</CardMeta>);

    const caption = screen.getByText("3 MEETINGS");
    expect(caption).toHaveClass(
      "self-center",
      "text-[11px]",
      "font-medium",
      "tracking-[0.08em]",
      "text-[color:var(--fg-muted)]",
    );
    expect(caption).not.toHaveClass("text-muted-foreground");
  });

  it("renders into the card header's trailing action slot", () => {
    render(<CardMeta>SNAPSHOT · NOW</CardMeta>);

    expect(screen.getByText("SNAPSHOT · NOW")).toHaveAttribute(
      "data-slot",
      "card-action",
    );
  });
});
