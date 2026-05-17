"""Email delivery — background job + dev-friendly default backend.

The web app enqueues ``send_confirmation_email`` on the ``email`` RQ queue;
the worker process imports this module and calls the job target. Until SMTP
credentials are wired in, the backend logs the link so dev/UAT can copy it
from worker output.
"""

import logging
import os
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode

log = logging.getLogger(__name__)


def _confirm_url(raw_token: str) -> str:
    base = os.environ.get("APP_BASE_URL", "http://localhost:5173").rstrip("/")
    query = urlencode({"token": raw_token})
    return f"{base}/confirm-email?{query}"


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


def send_confirmation_email(to_email: str, raw_token: str, username: str) -> None:
    """Render and deliver the confirmation email. Invoked by the RQ worker."""
    confirm_url = _confirm_url(raw_token)
    from_addr = os.environ.get("EMAIL_FROM", "noreply@fortymm.local")
    subject = "Confirm your FortyMM email"
    body = (
        f"Hi @{username},\n\n"
        "Click the link below to confirm your email address and claim your "
        "FortyMM account.\n\n"
        f"{confirm_url}\n\n"
        "If you didn't request this, you can ignore this email.\n"
    )

    if not _smtp_configured():
        log.info(
            "email_confirmation_link",
            extra={"to": to_email, "url": confirm_url},
        )
        # Print so dev users running `rq worker email` see the link in stdout
        # without configuring a logging format.
        print(f"[email] confirmation link for {to_email}: {confirm_url}")
        return

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = from_addr
    message["To"] = to_email
    message.set_content(body)
    _send_via_smtp(message)
