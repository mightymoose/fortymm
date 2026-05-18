"""Email delivery — background job + dev-friendly default backend.

The web app enqueues ``send_confirmation_email`` on the ``email`` RQ queue;
the worker process imports this module and calls the job target. In dev
(``FORTYMM_DEV=1``) the worker prints the confirmation link to stdout so
the local loop works without SMTP. In any other environment, missing SMTP
configuration is treated as a misconfiguration and the job raises so RQ
moves it to ``failed_job_registry`` for an operator to notice.
"""

import logging
import os
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode

log = logging.getLogger(__name__)


def _dev_mode() -> bool:
    return os.environ.get("FORTYMM_DEV", "").lower() in {"1", "true", "yes"}


def _app_base_url() -> str | None:
    base = os.environ.get("APP_BASE_URL")
    if base:
        return base.rstrip("/")
    if _dev_mode():
        return "http://localhost:5173"
    return None


def _confirm_url(raw_token: str) -> str:
    base = _app_base_url()
    if base is None:
        # Refuse to render a localhost URL into a real outbound email — that
        # was the failure mode that motivated this guard. Caller is expected
        # to catch and surface as a deploy misconfiguration.
        raise RuntimeError(
            "APP_BASE_URL must be set outside FORTYMM_DEV — refusing to "
            "render an unclickable localhost URL into a confirmation email."
        )
    query = urlencode({"token": raw_token})
    return f"{base}/confirm-email?{query}"


def _login_url(raw_token: str) -> str:
    base = _app_base_url()
    if base is None:
        raise RuntimeError(
            "APP_BASE_URL must be set outside FORTYMM_DEV — refusing to "
            "render an unclickable localhost URL into a sign-in email."
        )
    query = urlencode({"token": raw_token})
    return f"{base}/login/verifying?{query}"


def _smtp_configured() -> bool:
    return bool(os.environ.get("SMTP_HOST"))


def _send_via_smtp(message: EmailMessage) -> None:
    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USERNAME")
    password = os.environ.get("SMTP_PASSWORD")
    use_tls = os.environ.get("SMTP_USE_TLS", "true").lower() != "false"
    with smtplib.SMTP(host, port) as smtp:
        if use_tls:
            smtp.starttls()
        if user and password:
            smtp.login(user, password)
        smtp.send_message(message)


def _deliver(
    *,
    to_email: str,
    subject: str,
    body: str,
    log_event: str,
    log_url: str,
    dev_label: str,
) -> None:
    """Deliver an email via SMTP, or print + log it in dev. The ``log_event``
    and ``log_url`` are kept in dev logs only (gated on FORTYMM_DEV) so a
    prod deploy that forgets SMTP doesn't write bearer tokens to centralized
    logs. Outside dev, missing SMTP raises so RQ moves the job to
    ``failed_job_registry`` for an operator to notice."""
    if not _smtp_configured():
        if not _dev_mode():
            raise RuntimeError(
                "SMTP is not configured and FORTYMM_DEV is not set — "
                f"refusing to silently drop a {dev_label} email."
            )
        log.info(log_event, extra={"to": to_email, "url": log_url})
        print(f"[email] {dev_label} link for {to_email}: {log_url}")
        return

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = os.environ.get("EMAIL_FROM", "noreply@fortymm.local")
    message["To"] = to_email
    message.set_content(body)
    _send_via_smtp(message)


def send_confirmation_email(to_email: str, raw_token: str, username: str) -> None:
    """Render and deliver the confirmation email. Invoked by the RQ worker."""
    confirm_url = _confirm_url(raw_token)
    _deliver(
        to_email=to_email,
        subject="Confirm your FortyMM email",
        body=(
            f"Hi @{username},\n\n"
            "Click the link below to confirm your email address and claim your "
            "FortyMM account.\n\n"
            f"{confirm_url}\n\n"
            "If you didn't request this, you can ignore this email.\n"
        ),
        log_event="email_confirmation_link",
        log_url=confirm_url,
        dev_label="confirmation",
    )


def send_login_email(to_email: str, raw_token: str, username: str) -> None:
    """Render and deliver the magic-link sign-in email. Invoked by the RQ worker."""
    login_url = _login_url(raw_token)
    _deliver(
        to_email=to_email,
        subject="Your FortyMM sign-in link",
        body=(
            f"Hi @{username},\n\n"
            "Click the link below to sign in to FortyMM. The link is good for "
            "15 minutes and only works once.\n\n"
            f"{login_url}\n\n"
            "If you didn't ask to sign in, you can ignore this email — nobody "
            "can use the link without your inbox.\n"
        ),
        log_event="email_login_link",
        log_url=login_url,
        dev_label="sign-in",
    )
