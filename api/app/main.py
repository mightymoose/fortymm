import time

from fastapi import FastAPI

from app import queue

app = FastAPI(title="FortyMM API")

SOLVER_HEALTH_TIMEOUT = 10.0


@app.get("/v1/health")
def health() -> dict:
    return {"solver": _check_solver()}


def _check_solver() -> dict:
    try:
        job = queue.get_queue().enqueue(
            "app.solver.solve_hello_world", job_timeout=10
        )
    except Exception:
        return {"healthy": False}

    deadline = time.monotonic() + SOLVER_HEALTH_TIMEOUT
    while time.monotonic() < deadline:
        try:
            job.refresh()
        except Exception:
            return {"healthy": False}
        if job.is_finished:
            return {"healthy": bool(job.return_value())}
        if job.is_failed:
            return {"healthy": False}
        time.sleep(0.1)
    return {"healthy": False}
