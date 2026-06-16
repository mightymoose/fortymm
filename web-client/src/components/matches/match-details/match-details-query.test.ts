import { HttpResponse } from "msw";

import { ApiError } from "@/api/client";
import { buildMatchDetails } from "@/mocks/factories/matches/match-details.factory";
import { waitFor } from "@/test/utilities";

import {
  matchDetailsQuery,
  matchDetailsResultFromPayload,
} from "./match-details-query";
import { matchDetailsQueryPage } from "./match-details-query.page";

describe("matchDetailsQuery", () => {
  it("throws on error so route-level error boundaries catch failures", () => {
    expect(matchDetailsQuery("m-1").throwOnError).toBe(true);
  });

  it("returns the parsed scoreboard view", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data).toEqual({
      scoreboard: { status: match.data.scoreboard.status },
    });
  });

  it("keeps the full raw response on `unmigrated`", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The whole payload survives the parse — sides, games, etc., not just `data`.
    expect(result.current.data?.unmigrated).toEqual(match);
    expect(result.current.data?.unmigrated.sides).toHaveLength(
      match.sides.length,
    );
  });

  it("surfaces an error when the payload fails validation", async () => {
    const malformed = buildMatchDetails({
      data: { scoreboard: { status: "not-a-real-status" as never } },
    });
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(malformed));

    const { result } = matchDetailsQueryPage.render();

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("surfaces an ApiError when the request fails", async () => {
    matchDetailsQueryPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    );

    const { result } = matchDetailsQueryPage.render("m-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(500);
    // No detail body, so the message falls back to the labelled action.
    expect((result.current.error as ApiError).message).toBe(
      "Failed to load match m-1",
    );
  });
});

describe("matchDetailsResultFromPayload", () => {
  it("produces the same shape the queryFn resolves to, so a seeded cache reads identically", async () => {
    const match = buildMatchDetails();
    matchDetailsQueryPage.mockEndpoint(() => HttpResponse.json(match));

    const { result } = matchDetailsQueryPage.render();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Seeding from the payload the create response already holds yields exactly
    // what a fresh fetch would have cached — no GET required (#510).
    expect(matchDetailsResultFromPayload(match)).toEqual(result.current.data);
  });

  it("throws on a malformed payload rather than priming a bad cache entry", () => {
    const malformed = buildMatchDetails({
      data: { scoreboard: { status: "not-a-real-status" as never } },
    });
    expect(() => matchDetailsResultFromPayload(malformed)).toThrow();
  });
});
