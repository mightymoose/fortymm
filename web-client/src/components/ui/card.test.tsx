import { render, screen } from "@/test/utilities";

import { Card, CardContent, CardTitle } from "./card";

const card = () =>
  document.querySelector('[data-slot="card"]') as HTMLElement;

describe("Card", () => {
  it("renders a plain div container by default", () => {
    render(
      <Card className="mt-8">
        <CardContent>Body</CardContent>
      </Card>,
    );

    // Guards every existing caller (dashboard, tournament, /design-system):
    // the default rendering must stay an anonymous <div> with the card's
    // styling, so opting in to `asChild` can't change anyone else's DOM.
    expect(card().tagName).toBe("DIV");
    expect(card()).toHaveAttribute("data-size", "default");
    expect(card()).toHaveClass("bg-card", "rounded-xl", "mt-8");
  });

  it("renders as the caller's element when asChild, forwarding its classes", () => {
    render(
      // The <section> deliberately carries no card classes of its own — every
      // card class on it below must have arrived via the Slot.
      <Card asChild className="mt-8">
        <section aria-labelledby="panel-heading">
          <CardTitle id="panel-heading">Head to head</CardTitle>
          <CardContent>Body</CardContent>
        </section>
      </Card>,
    );

    expect(card().tagName).toBe("SECTION");
    // The card's own base classes and the caller's className both land on the
    // child element, so it looks identical to a default card.
    expect(card()).toHaveClass("bg-card", "rounded-xl", "mt-8");
    expect(card()).toHaveAttribute("data-size", "default");
    // The child's own props survive — this is the point of the opt-in: the
    // panel stays a labelled landmark region instead of an anonymous div.
    expect(card()).toHaveAttribute("aria-labelledby", "panel-heading");
    expect(
      screen.getByRole("region", { name: "Head to head" }),
    ).toBe(card());
  });
});
