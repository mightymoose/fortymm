import userEvent from "@testing-library/user-event";

import { fireEvent } from "@/test/utilities";

import { buildFilterRowProps, buildFilterTabView } from "./filter-row.factory";
import { filterRowPage } from "./filter-row.page";

describe("FilterRow", () => {
  it("mirrors q into the search input value", () => {
    filterRowPage.render({ q: "silva" });

    expect(filterRowPage.getSearchInput()).toHaveValue("silva");
  });

  it("calls setQ on each keystroke", () => {
    const setQ = vi.fn();
    filterRowPage.render({ q: "", setQ });

    fireEvent.change(filterRowPage.getSearchInput(), {
      target: { value: "nguyen" },
    });

    expect(setQ).toHaveBeenCalledWith("nguyen");
  });

  it("shows the clear (X) button only when q is non-empty and clears to '' on click", () => {
    const setQ = vi.fn();
    filterRowPage.render({ q: "rita", setQ });

    fireEvent.click(filterRowPage.getClearSearchButton());

    expect(setQ).toHaveBeenCalledWith("");
  });

  it("hides the clear (X) button when q is empty", () => {
    filterRowPage.render({ q: "" });

    expect(filterRowPage.queryClearSearchButton()).toBeNull();
  });

  it("renders all provided tabs with their labels and seg-count counts", () => {
    filterRowPage.render(buildFilterRowProps());

    expect(filterRowPage.getTab(/^all/i)).toHaveTextContent("7");
    expect(filterRowPage.getTab(/live/i)).toHaveTextContent("2");
    expect(filterRowPage.getTab(/up next/i)).toHaveTextContent("3");
    expect(filterRowPage.getTab(/final/i)).toHaveTextContent("2");
  });

  it("omits the seg-count when a tab's count is null", () => {
    filterRowPage.render({
      tabs: [buildFilterTabView({ value: "all", label: "All", count: null })],
    });

    const tab = filterRowPage.getTab(/all/i);
    expect(tab).toHaveTextContent("All");
    expect(tab.querySelector(".seg-count")).toBeNull();
  });

  it("renders the live-dot on the Live tab", () => {
    filterRowPage.render({
      tabs: [
        buildFilterTabView({ value: "live", label: "Live", isLive: true, count: 2 }),
      ],
    });

    expect(filterRowPage.getTab(/live/i).querySelector(".live-dot")).not.toBeNull();
  });

  it("calls setStatus with the tab value when a tab is selected", async () => {
    const user = userEvent.setup();
    const setStatus = vi.fn();
    filterRowPage.render({ setStatus });

    await user.click(filterRowPage.getTab(/up next/i));

    expect(setStatus).toHaveBeenCalledWith("scheduled");
  });
});
