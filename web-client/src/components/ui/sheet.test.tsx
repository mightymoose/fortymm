import { render } from "@/test/utilities";

import { Sheet, SheetContent, SheetTitle } from "./sheet";

const content = () =>
  document.querySelector('[data-slot="sheet-content"]') as HTMLElement;

describe("SheetContent", () => {
  it("applies the side's default width when no override is given", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Panel</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(content()).toHaveClass("w-[320px]");
  });

  it("lets a consumer override the width without !important (#623)", () => {
    render(
      <Sheet open>
        <SheetContent className="w-[560px]">
          <SheetTitle>Panel</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    // tailwind-merge drops the base width in favour of the consumer's, so no
    // `!important` specificity hack is needed.
    expect(content()).toHaveClass("w-[560px]");
    expect(content()).not.toHaveClass("w-[320px]");
  });
})
