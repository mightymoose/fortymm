"""Mixed-version notification workers never reserve one another's jobs."""

import json
from pathlib import Path

import fakeredis
from rq import Queue

from app import queue as queue_module
from app.notifications import jobs as notification_jobs
from app.notifications.service import enqueue_notification_job
from app.notifications.taxonomy import NotificationCategory
from app.schemas.notification import NotificationJob


def test_outer_notification_rollout_keeps_legacy_jobs_drainable_and_isolates_v2(
    monkeypatch,
) -> None:
    connection = fakeredis.FakeStrictRedis()
    legacy = Queue("notifications", connection=connection, is_async=True)
    current = Queue("notifications-v2", connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_notifications_queue", lambda: legacy)
    monkeypatch.setattr(
        queue_module,
        "get_notifications_v2_queue",
        lambda: current,
        raising=False,
    )

    job = NotificationJob(
        user_id="00000000-0000-0000-0000-000000001770",
        category=NotificationCategory.PAYMENTS,
        title="Payment needs attention",
        body="Contact support with reference PAY-1770.",
        email_already_delivered_to="private@example.com",
    )
    legacy.enqueue(notification_jobs.DELIVER_NOTIFICATION_JOB, job.model_dump_json())
    assert enqueue_notification_job(job)

    # An old worker only polls this queue. It must see no newly produced work,
    # while its deployed entry point remains present for already-queued jobs.
    [legacy_job] = legacy.get_jobs()
    assert legacy_job.func_name == "app.notifications.jobs.deliver_notification"
    assert callable(notification_jobs.deliver_notification)

    [queued] = current.get_jobs()
    assert queued.origin == "notifications-v2"
    assert queued.func_name == "app.notifications.jobs.deliver_notification_v2"
    assert len(queued.args) == 1
    payload = json.loads(queued.args[0])
    assert payload["version"] == 2
    assert payload["notification"]["user_id"] == str(job.user_id)
    assert "private@example.com" not in queued.args[0]


def test_each_runtime_polls_new_then_legacy_notification_queues() -> None:
    root = Path(__file__).resolve().parents[2]
    configurations = {
        "development": (root / "docker-compose.dev.yml").read_text(),
        "QA": (root / "docker-compose.qa.yml").read_text(),
        "Helm": (root / "deploy/fortymm/values.yaml").read_text(),
    }

    for runtime, contents in configurations.items():
        outer_v2 = contents.index("notifications-v2")
        outer_legacy = contents.index(
            "notifications", outer_v2 + len("notifications-v2")
        )
        email_v2 = contents.index("notification-email-v2")
        email_legacy = contents.index("email", email_v2 + len("notification-email-v2"))
        assert outer_v2 < outer_legacy, f"{runtime} must drain v2 before legacy"
        assert email_v2 < email_legacy, (
            f"{runtime} must drain versioned email before legacy email"
        )
