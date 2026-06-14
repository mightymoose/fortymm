import { buildStatusBadgeView } from "./status-badge.factory";
import { statusBadgePage } from "./status-badge.page";

describe("StatusBadge", () => {
  it("renders the status label text", () => {
    statusBadgePage.render({
      status: buildStatusBadgeView({ label: "Up next" }),
    });

    expect(statusBadgePage.getBadge("Up next")).toHaveTextContent("Up next");
  });

  it("applies the status-pill plus the provided tone class", () => {
    statusBadgePage.render({
      status: buildStatusBadgeView({
        label: "Final",
        toneClass: "status-tone-final",
      }),
    });

    const badge = statusBadgePage.getBadge("Final");
    expect(badge).toHaveClass("status-pill");
    expect(badge).toHaveClass("status-tone-final");
  });

  it("renders the live-dot only when isLive is true", () => {
    statusBadgePage.render({
      status: buildStatusBadgeView({ label: "LIVE", isLive: true }),
    });

    expect(statusBadgePage.queryLiveDot("LIVE")).not.toBeNull();
  });

  it("omits the live-dot for a non-live status", () => {
    statusBadgePage.render({
      status: buildStatusBadgeView({ label: "Final", isLive: false }),
    });

    expect(statusBadgePage.queryLiveDot("Final")).toBeNull();
  });
});
