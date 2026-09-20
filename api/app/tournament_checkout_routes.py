"""HTTP adapter for combined tournament checkout holds."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import User
from app.schemas.tournament_checkout import (
    TournamentCheckoutCreate,
    TournamentCheckoutRead,
    TournamentCheckoutRefusalResponse,
)
from app.sessions import get_current_user
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

router = APIRouter(prefix="/v1")


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
