import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Health from "~/routes/health";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

describe("Health", () => {
  it("shows that the app is healthy", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        loader: () => ({ result: "healthy" }),
        element: <Health />,
      },
    ]);
    render(
      <RouterProvider router={router} />
    );

    await waitFor(() => 
      expect(screen.getByText("healthy")).toBeInTheDocument()
    );
  });
});
