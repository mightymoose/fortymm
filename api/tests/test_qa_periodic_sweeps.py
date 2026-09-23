"""Deployment contract for the prod-like QA stack's periodic work."""

import re
from pathlib import Path


def _compose_service(contents: str, service_name: str) -> str:
    marker = f"  {service_name}:\n"
    start = contents.index(marker)
    remainder = contents[start + len(marker) :]
    next_service = re.search(r"(?m)^  [a-z0-9-]+:\s*$", remainder)
    return remainder if next_service is None else remainder[: next_service.start()]


def test_qa_periodic_runner_executes_payment_recovery_with_shared_runtime() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    compose = (repo_root / "docker-compose.qa.yml").read_text()
    periodic = _compose_service(compose, "retirement-sweep")

    required_sweeps = (
        "app.retirement_sweep",
        "app.email_token_sweep",
        "app.payment_reconciliation_sweep",
        "app.tournament_receipt_pii_sweep",
    )
    for sweep in required_sweeps:
        assert periodic.count(f"python -m {sweep}") == 1, (
            f"QA periodic runner must execute {sweep} exactly once per cycle"
        )

    assert "<<: *api-service" in periodic
    assert "<<: *mailpit-smtp" in periodic
    assert (
        "DATABASE_URL: postgresql+asyncpg://postgres:postgres@postgres:5432/fortymm"
        in periodic
    )
    assert "REDIS_URL: redis://redis:6379/0" in periodic
    assert "postgres:\n        condition: service_healthy" in periodic
    assert "redis:\n        condition: service_healthy" in periodic
