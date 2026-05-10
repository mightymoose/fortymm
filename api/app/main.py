import time

from fastapi import FastAPI
from pydantic import BaseModel

from app import queue

app = FastAPI(title="FortyMM API")

SOLVER_HEALTH_TIMEOUT = 10.0


class SolverHealth(BaseModel):
    healthy: bool


class HealthResponse(BaseModel):
    solver: SolverHealth


@app.get("/v1/health")
def health() -> HealthResponse:
    return HealthResponse(solver=_check_solver())


def _check_solver() -> SolverHealth:
    try:
        job = queue.get_queue().enqueue(
            "app.solver.solve_hello_world", job_timeout=10
        )
    except Exception:
        return SolverHealth(healthy=False)

    deadline = time.monotonic() + SOLVER_HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        try:
            job.refresh()
        except Exception:
            return SolverHealth(healthy=False)
        if job.is_finished:
            return SolverHealth(healthy=bool(job.return_value()))
        if job.is_failed:
            return SolverHealth(healthy=False)
        time.sleep(0.1)
    return SolverHealth(healthy=False)
