import { buildStatusChipView } from "./status-chip.factory";
import { statusChipPage } from "./status-chip.page";

describe("StatusChip", () => {
  it.each([
    ["scheduled", "outline"],
    ["live", "default"],
    ["final", "secondary"],
  ] as const)(
    "renders the chip for a %s match with its label as a %s Badge",
    (status, variant) => {
      statusChipPage.render({
        chip: buildStatusChipView({ status, label: "chip label" }),
      });

      const chip = statusChipPage.getChip();
      expect(chip).toHaveTextContent("chip label");
      expect(chip).toHaveAttribute("data-variant", variant);
    },
  );

});
