"""Deployment guards for server-owned Stripe payment configuration."""

from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "template_path",
    [
        "deploy/fortymm/templates/api.yaml",
        "deploy/fortymm/templates/worker.yaml",
        "deploy/fortymm/templates/payment-reconciliation-cronjob.yaml",
    ],
)
@pytest.mark.parametrize(
    "setting",
    ["STRIPE_LIVEMODE", "STRIPE_API_VERSION"],
)
def test_stripe_runtime_settings_are_explicitly_pinned_after_bulk_secret_env(
    template_path: str,
    setting: str,
) -> None:
    """Explicit container env must outrank a stale duplicate from envFrom."""
    template = (REPO_ROOT / template_path).read_text()
    bulk_env = '{{- include "fortymm.appEnvFrom" .'
    lines = [line.strip() for line in template.splitlines()]
    explicit_pin = [
        f"- name: {setting}",
        f'value: {{{{ index .Values.config "{setting}" | quote }}}}',
    ]

    assert bulk_env in template
    assert any(
        lines[index : index + len(explicit_pin)] == explicit_pin
        for index in range(len(lines) - len(explicit_pin) + 1)
    )
