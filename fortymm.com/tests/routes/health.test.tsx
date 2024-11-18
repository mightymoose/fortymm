import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Health, { HealthStatus, loader } from "~/routes/health";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

describe("<Health />", () => {
  it("shows that the app is healthy when the database connection is working", async () => {
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

    expect(screen.queryByText("unhealthy")).not.toBeInTheDocument();
  });

  it("shows that the app is unhealthy when the database connection is not working", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        loader: () => ({ result: "unhealthy" }),
        element: <Health />,
      },
    ]);
    render(
      <RouterProvider router={router} />
    );

    await waitFor(() => 
      expect(screen.getByText("unhealthy")).toBeInTheDocument()
    );

    expect(screen.queryByText("healthy")).not.toBeInTheDocument();
  });
});
