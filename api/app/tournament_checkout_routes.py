"""HTTP adapter for combined tournament checkout holds."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import (
    Tournament,
    User,
)
from app.payment_provider import (
    PaymentProvider,
    PaymentProviderSignatureError,
    get_payment_provider,
)
from app.schemas.tournament_checkout import (
    ActionableCheckoutsRead,
    TournamentCheckoutCreate,
    TournamentCheckoutRead,
    TournamentCheckoutRefusalResponse,
    TournamentPaymentPrepare,
    TournamentPaymentProblemList,
    TournamentPaymentProblemRead,
    TournamentPaymentRead,
)
from app.sessions import get_current_user
from app.tournament_checkout_attention import list_checkout_attention
from app.tournament_checkout_errors import (
    CheckoutNotFoundError,
    CheckoutRateLimitedError,
    CheckoutRateLimitUnavailableError,
    CheckoutRefusedError,
)
from app.tournament_checkouts import (
    cancel_checkout,
    read_checkout,
    read_current_checkout,
    start_checkout,
)
from app.tournament_payment_queries import (
    list_tournament_payment_problems as query_payment_problems,
)
from app.tournament_payment_reconciliation import (
    persist_verified_event,
    process_verified_event,
)
from app.tournament_payments import (
    PaymentCollectionDisabledError,
    PaymentNotFoundError,
    prepare_payment,
    read_payment_status,
)

router = APIRouter(prefix="/v1")


@router.get(
    "/tournaments/{tournament_id}/payment-problems",
    response_model=TournamentPaymentProblemList,
)
async def list_tournament_payment_problems(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentPaymentProblemList:
    """Owner-only safe projection; provider evidence and secrets stay internal."""
    tournament = await db.get(Tournament, tournament_id)
    if tournament is None:
        raise HTTPException(status_code=404, detail="Tournament not found.")
    if tournament.owner_account_id != current_user.id:
        raise HTTPException(status_code=403, detail="Tournament owner required.")

    problems = await query_payment_problems(db, tournament_id=tournament_id)
    return TournamentPaymentProblemList(
        items=[
            TournamentPaymentProblemRead(
                support_reference=problem.support_reference,
                state=problem.state,
                checkout_id=problem.checkout_id,
            )
            for problem in problems
        ]
    )


@router.get("/checkouts", response_model=ActionableCheckoutsRead)
async def get_actionable_checkouts(
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ActionableCheckoutsRead:
    """List this payer's actionable checkouts; terminal history is omitted."""
    return ActionableCheckoutsRead(
        items=await list_checkout_attention(db, payer_account_id=current_user.id)
    )


def get_reconciliation_payment_provider(
    provider: PaymentProvider = Depends(get_payment_provider),
) -> PaymentProvider:
    """Distinct route seam while preserving the injectable provider root."""
    return provider


def _checkout_refusal(error: CheckoutRefusedError) -> HTTPException:
    detail: dict[str, str] = {
        "code": error.refusal.value,
        "message": str(error),
    }
    if error.event_id is not None:
        detail["event_id"] = str(error.event_id)
    return HTTPException(status_code=409, detail=detail)


@router.post(
    "/tournaments/{tournament_id}/checkouts",
    response_model=TournamentCheckoutRead,
    status_code=status.HTTP_201_CREATED,
    responses={
        409: {"model": TournamentCheckoutRefusalResponse},
        429: {"description": "Checkout admission limit exceeded."},
        503: {"description": "Checkout admission budget unavailable."},
    },
)
async def start_tournament_checkout(
    tournament_id: uuid.UUID,
    payload: TournamentCheckoutCreate,
    request: Request,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentCheckoutRead:
    """Start or resume one immutable combined paid-event checkout hold."""
    try:
        return await start_checkout(
            db,
            tournament_id=tournament_id,
            actor=current_user,
            request=payload,
            client_ip=request.client.host if request.client else "unknown",
        )
    except CheckoutNotFoundError as error:
        raise HTTPException(
            status_code=404, detail="Checkout target not found."
        ) from error
    except CheckoutRefusedError as error:
        raise _checkout_refusal(error) from error
    except CheckoutRateLimitedError as error:
        raise HTTPException(
            status_code=429,
            detail="Too many checkout attempts from this network; retry shortly.",
        ) from error
    except CheckoutRateLimitUnavailableError as error:
        raise HTTPException(
            status_code=503,
            detail="Checkout is temporarily unavailable. Retry shortly.",
            headers={"Retry-After": "5"},
        ) from error


@router.get(
    "/tournaments/{tournament_id}/checkouts/current",
    response_model=TournamentCheckoutRead,
)
async def get_current_tournament_checkout(
    tournament_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentCheckoutRead:
    """Resume this Player's active checkout on this or another device."""
    try:
        return await read_current_checkout(
            db, tournament_id=tournament_id, actor=current_user
        )
    except CheckoutNotFoundError as error:
        raise HTTPException(status_code=404, detail="No active checkout.") from error


@router.get(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}",
    response_model=TournamentCheckoutRead,
)
async def get_tournament_checkout(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentCheckoutRead:
    """Read an authorized checkout's server-owned quote and deadline."""
    try:
        return await read_checkout(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
        )
    except CheckoutNotFoundError as error:
        raise HTTPException(status_code=404, detail="Checkout not found.") from error


@router.delete(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}",
    response_model=TournamentCheckoutRead,
)
async def cancel_tournament_checkout(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> TournamentCheckoutRead:
    """Explicitly cancel checkout and release every selected place together."""
    try:
        return await cancel_checkout(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
        )
    except CheckoutNotFoundError as error:
        raise HTTPException(status_code=404, detail="Checkout not found.") from error


@router.post(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}/payment",
    response_model=TournamentPaymentRead,
    responses={409: {"model": TournamentCheckoutRefusalResponse}},
)
async def prepare_tournament_checkout_payment(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    payload: TournamentPaymentPrepare,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    provider: PaymentProvider = Depends(get_payment_provider),
) -> TournamentPaymentRead:
    """Prepare or resume the checkout's one card-only provider intent."""
    try:
        return await prepare_payment(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
            provider=provider,
            receipt_email=(
                str(payload.receipt_email)
                if payload.receipt_email is not None
                else None
            ),
            receipt_email_supplied="receipt_email" in payload.model_fields_set,
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Checkout not found.") from error
    except PaymentCollectionDisabledError as error:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "collection_disabled",
                "message": "Payment collection is disabled for new checkouts.",
            },
        ) from error


@router.get(
    "/tournaments/{tournament_id}/checkouts/{checkout_id}/payment",
    response_model=TournamentPaymentRead,
)
async def get_tournament_checkout_payment(
    tournament_id: uuid.UUID,
    checkout_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    provider: PaymentProvider = Depends(get_reconciliation_payment_provider),
) -> TournamentPaymentRead:
    """Retrieve provider truth and reconcile; redirect query strings are ignored."""
    try:
        return await read_payment_status(
            db,
            tournament_id=tournament_id,
            checkout_id=checkout_id,
            actor=current_user,
            provider=provider,
        )
    except PaymentNotFoundError as error:
        raise HTTPException(status_code=404, detail="Checkout not found.") from error


@router.post("/webhooks/stripe", status_code=200)
async def receive_stripe_webhook(
    request: Request,
    db: AsyncSession = Depends(get_session),
    provider: PaymentProvider = Depends(get_payment_provider),
) -> Response:
    payload = await request.body()
    try:
        event = await provider.verify_webhook(
            payload, request.headers.get("stripe-signature")
        )
    except PaymentProviderSignatureError as error:
        raise HTTPException(
            status_code=400, detail="Invalid webhook signature."
        ) from error
    # The verified envelope is durable before any domain processing, so a
    # worker crash or admission bug is replayable rather than acknowledged loss.
    await persist_verified_event(db, event)
    await db.commit()
    await process_verified_event(db, event)
    await db.commit()
    return Response(status_code=200)
