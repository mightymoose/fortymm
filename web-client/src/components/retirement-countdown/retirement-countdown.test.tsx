import { retirementCountdownPage } from "./retirement-countdown.page";

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("RetirementCountdown", () => {
  it("states the days remaining in the muted band when the deadline is far off", () => {
    retirementCountdownPage.render({ deadline: inMs(3 * DAY + HOUR) });

    expect(retirementCountdownPage.getCountdown()).toHaveTextContent(
      "3 days left to respond",
    );
    expect(retirementCountdownPage.getTone()).toBe("normal");
  });

  it("escalates to the urgent band as the deadline nears zero", () => {
    retirementCountdownPage.render({ deadline: inMs(30 * 60 * 1000) });

    expect(retirementCountdownPage.getCountdown()).toHaveTextContent(
      "30 minutes left to respond",
    );
    expect(retirementCountdownPage.getTone()).toBe("urgent");
  });

  it("uses the warn band inside the final day, counting in hours", () => {
    retirementCountdownPage.render({ deadline: inMs(5 * HOUR + 10 * 60 * 1000) });

    expect(retirementCountdownPage.getCountdown()).toHaveTextContent(
      "5 hours left to respond",
    );
    expect(retirementCountdownPage.getTone()).toBe("soon");
  });

  it("shows the closed-window notice once the deadline has passed", () => {
    retirementCountdownPage.render({ deadline: inMs(-HOUR) });

    expect(retirementCountdownPage.getCountdown()).toHaveTextContent(
      "Time to respond has passed",
    );
    expect(retirementCountdownPage.getTone()).toBe("expired");
  });

  it("renders nothing when there is no deadline", () => {
    retirementCountdownPage.render({ deadline: null });

    expect(retirementCountdownPage.queryCountdown()).not.toBeInTheDocument();
  });
});
