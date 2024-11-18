import { useLoaderData } from "@remix-run/react";
import { cva } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

type HealthStatus = "healthy" | "unhealthy";

export const loader = () => {
  return {
    result: "healthy" as HealthStatus,
  };
};

const backgroundVariants = cva("h-screen w-screen", {
  variants: {
    status: {
      healthy: "bg-green-700",
      unhealthy: "bg-red-700",
    },
  },
});

const textVariants = cva("text-4xl font-bold capitalize", {
  variants: {
    status: {
      healthy: "text-green-200",
      unhealthy: "text-red-200",
    },
  },
});

export default function Health() {
  const { result } = useLoaderData<typeof loader>();

  const styles = {
    healthy: {
      bg: "bg-green-700",
      text: "text-green-200",
    },
    unhealthy: {
      bg: "bg-red-700",
      text: "text-red-200",
    },
  };

  return (
    <div className={twMerge(backgroundVariants({ status: result }))}>
      <div className="flex h-full w-full items-center justify-center">
        <h1 className={twMerge(textVariants({ status: result }))}>{result}</h1>
      </div>
    </div>
  );
}
