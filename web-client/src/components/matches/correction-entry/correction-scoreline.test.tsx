import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { correctionScorelinePage } from "./correction-scoreline.page";

describe("CorrectionScoreline", () => {
  it("marks the open game as the active (aria-current) cell", () => {
    correctionScorelinePage.render({ activeGameNumber: 2 });

    expect(correctionScorelinePage.getActiveCell()).toBe(
      correctionScorelinePage.getCell(2),
    );
  });

  it("selects a game on click", async () => {
    const onSelect = vi.fn();
    correctionScorelinePage.render({ onSelect });

    await userEvent.click(correctionScorelinePage.getCell(3));

    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it("renders an empty slot as a dash with no clear affordance", () => {
    correctionScorelinePage.render();

    // Games 4–5 are empty in the default seed.
    expect(correctionScorelinePage.getCell(4)).toHaveTextContent("—");
    expect(correctionScorelinePage.queryClear(4)).not.toBeInTheDocument();
    // A filled game offers the hover-✕ clear.
    expect(correctionScorelinePage.queryClear(1)).toBeInTheDocument();
  });

  it("clears a filled game without selecting it", async () => {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    correctionScorelinePage.render({ onSelect, onClear });

    await userEvent.click(correctionScorelinePage.getClear(2));

    expect(onClear).toHaveBeenCalledWith(2);
    // The ✕ stops propagation, so the cell's select doesn't also fire.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("flags a non-active half-entered / illegal game so a disabled Send has a visible cause", () => {
    correctionScorelinePage.render({
      // The flagged game isn't the open one (the open game shows its own error
      // in the pad); a *non-active* invalid cell wears the failed treatment.
      activeGameNumber: 2,
      cells: [
        {
          gameNumber: 1,
          myPoints: "11",
          oppPoints: null,
          myWin: null,
          invalid: true,
        },
        {
          gameNumber: 2,
          myPoints: null,
          oppPoints: null,
          myWin: null,
          invalid: false,
        },
      ],
    });

    expect(correctionScorelinePage.getCell(1)).toHaveClass("failed");
  });
});
