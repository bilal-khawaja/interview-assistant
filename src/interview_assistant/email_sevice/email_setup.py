import asyncio
import os
import smtplib
from email.message import EmailMessage

from dotenv import load_dotenv

load_dotenv()

invitation_url = os.getenv("INVITATION_URL", "http://localhost:8000/signin")


def _send_message(message: EmailMessage) -> None:
    host = os.getenv("SMTP_HOST", "localhost")
    port = int(os.getenv("SMTP_PORT", "1025"))
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    use_tls = os.getenv("SMTP_USE_TLS", "false").lower() == "true"

    with smtplib.SMTP(host, port) as smtp:
        if use_tls:
            smtp.starttls()
        if username and password:
            smtp.login(username, password)
        smtp.send_message(message)


async def send_welcome_email(
    recipient: str,
    name: str,
    role: str,
) -> None:
    message = EmailMessage()
    message["Subject"] = "Your Interview Assistant account is ready"
    message["From"] = os.getenv(
        "SMTP_FROM_EMAIL", "no-reply@interview-assistant.local"
    )
    message["To"] = recipient
    link = invitation_url
    message.set_content(
        f"Hello {name},\n\n"
        f"Your account has been created with the role: {role}.\n"
        f"Sign in here: {link}\n"
    )
    await asyncio.to_thread(_send_message, message)
