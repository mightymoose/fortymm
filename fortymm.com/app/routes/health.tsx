import { useLoaderData } from "@remix-run/react";
import { cva } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import db from "~/db.server";

export enum HealthStatus {
  Healthy = "healthy",
  Unhealthy = "unhealthy",
}

export const loader = async () => {
  try {
    const result = await db.execute(`SELECT 1 as database_health`);
    const [{ database_health }] = result.rows;

    return {
      result: database_health
        ? HealthStatus.Healthy
        : HealthStatus.Unhealthy,
    };
  } catch (error) {
    return {
      result: HealthStatus.Unhealthy,
    };
  }
};

const backgroundVariants = cva("h-screen w-screen", {
  variants: {
    status: {
      [HealthStatus.Healthy]: "bg-green-700",
      [HealthStatus.Unhealthy]: "bg-red-700",
    },
  },
});

const textVariants = cva("text-4xl font-bold capitalize", {
  variants: {
    status: {
      [HealthStatus.Healthy]: "text-green-200",
      [HealthStatus.Unhealthy]: "text-red-200",
    },
  },
});

export default function Health() {
  const { result } = useLoaderData<typeof loader>();

  return (
    <div className={twMerge(backgroundVariants({ status: result }))}>
      <div className="flex h-full w-full items-center justify-center">
        <h1 className={twMerge(textVariants({ status: result }))}>{result}</h1>
      </div>
    </div>
  );
}
