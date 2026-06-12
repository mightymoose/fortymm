import { buildInfoRowView } from "./info-row.factory";
import { infoRowPage } from "./info-row.page";

describe("InfoRow", () => {
  it("renders the row's label as its term", () => {
    infoRowPage.render({ row: buildInfoRowView({ label: "Status" }) });

    expect(infoRowPage.getLabel("Status")).toBeInTheDocument();
  });

  it("pairs the value with the row's label", () => {
    infoRowPage.render({
      row: buildInfoRowView({ label: "Rated", value: "Yes" }),
    });

    expect(infoRowPage.getValue("Rated")).toHaveTextContent(/^Yes$/);
  });
});
