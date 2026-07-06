import uuid
from collections.abc import Awaitable, Callable, Sequence

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.leagues import add_user_to_default_league
from app.models import Permission, Role, RolePermission, User, UserRole
from app.schemas.rbac import (
    PermissionCreate,
    PermissionRead,
    PermissionUpdate,
    RbacUserCreate,
    RbacUserRead,
    RbacUserRolesUpdate,
    RoleCreate,
    RoleRead,
    RoleUpdate,
)
from app.sessions import get_current_user
from app.uniqueness import name_taken

# ----- authorization -------------------------------------------------------


# Reads and writes on every endpoint here require this permission. The
# Administration overview page (which doesn't hit any RBAC route) needs
# `administration.view` instead, but that gate is enforced client-side —
# this router has no overview endpoint to protect.
RBAC_PERMISSION = "authorization.manage"


async def _user_has_permission(db: AsyncSession, user_id: uuid.UUID, name: str) -> bool:
    result = await db.execute(
        select(Permission.id)
        .join(RolePermission, RolePermission.permission_id == Permission.id)
        .join(UserRole, UserRole.role_id == RolePermission.role_id)
        .where(UserRole.user_id == user_id, Permission.name == name)
        .limit(1)
    )
    return result.first() is not None


def require_permission(name: str) -> Callable[..., Awaitable[User]]:
    async def dep(
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_session),
    ) -> User:
        if not await _user_has_permission(db, user.id, name):
            raise HTTPException(status_code=403, detail="Forbidden.")
        return user

    return dep


_require_rbac = require_permission(RBAC_PERMISSION)

router = APIRouter(prefix="/v1", dependencies=[Depends(_require_rbac)])


# ----- helpers -------------------------------------------------------------


async def _load_role_permission_map(
    db: AsyncSession, role_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not role_ids:
        return {}
    # Stable order: tests and the UI assume sorted permission_ids.
    result = await db.execute(
        select(RolePermission.role_id, RolePermission.permission_id)
        .join(Permission, Permission.id == RolePermission.permission_id)
        .where(RolePermission.role_id.in_(role_ids))
        .order_by(Permission.name)
    )
    grouped: dict[uuid.UUID, list[uuid.UUID]] = {rid: [] for rid in role_ids}
    for role_id, permission_id in result.all():
        grouped[role_id].append(permission_id)
    return grouped


async def _load_user_role_map(
    db: AsyncSession, user_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not user_ids:
        return {}
    result = await db.execute(
        select(UserRole.user_id, UserRole.role_id)
        .join(Role, Role.id == UserRole.role_id)
        .where(UserRole.user_id.in_(user_ids))
        .order_by(Role.name)
    )
    grouped: dict[uuid.UUID, list[uuid.UUID]] = {uid: [] for uid in user_ids}
    for user_id, role_id in result.all():
        grouped[user_id].append(role_id)
    return grouped


def _serialize_role(role: Role, permission_ids: list[uuid.UUID]) -> RoleRead:
    return RoleRead.model_validate(
        {
            "id": role.id,
            "name": role.name,
            "description": role.description,
            "created_at": role.created_at,
            "updated_at": role.updated_at,
            "permission_ids": permission_ids,
        }
    )


def _serialize_user(user: User, role_ids: list[uuid.UUID]) -> RbacUserRead:
    return RbacUserRead.model_validate(
        {
            "id": user.id,
            "username": user.username,
            "created_at": user.created_at,
            "role_ids": role_ids,
        }
    )


async def _get_role_or_404(db: AsyncSession, role_id: uuid.UUID) -> Role:
    role = (
        await db.execute(select(Role).where(Role.id == role_id))
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found.")
    return role


async def _get_permission_or_404(
    db: AsyncSession, permission_id: uuid.UUID
) -> Permission:
    perm = (
        await db.execute(select(Permission).where(Permission.id == permission_id))
    ).scalar_one_or_none()
    if perm is None:
        raise HTTPException(status_code=404, detail="Permission not found.")
    return perm


async def _get_user_or_404(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return user


async def _validate_permission_ids(
    db: AsyncSession, permission_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    deduped = list(dict.fromkeys(permission_ids))
    if not deduped:
        return []
    result = await db.execute(select(Permission.id).where(Permission.id.in_(deduped)))
    found = set(result.scalars().all())
    missing = [pid for pid in deduped if pid not in found]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown permission ids: {', '.join(str(m) for m in missing)}.",
        )
    return deduped


async def _validate_role_ids(
    db: AsyncSession, role_ids: Sequence[uuid.UUID]
) -> list[uuid.UUID]:
    deduped = list(dict.fromkeys(role_ids))
    if not deduped:
        return []
    result = await db.execute(select(Role.id).where(Role.id.in_(deduped)))
    found = set(result.scalars().all())
    missing = [rid for rid in deduped if rid not in found]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown role ids: {', '.join(str(m) for m in missing)}.",
        )
    return deduped


# ----- permissions ---------------------------------------------------------


@router.get("/permissions", response_model=list[PermissionRead])
async def list_permissions(
    db: AsyncSession = Depends(get_session),
) -> list[PermissionRead]:
    result = await db.execute(select(Permission).order_by(Permission.name))
    return [PermissionRead.model_validate(p) for p in result.scalars().all()]


@router.post(
    "/permissions",
    response_model=PermissionRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_permission(
    payload: PermissionCreate,
    db: AsyncSession = Depends(get_session),
) -> PermissionRead:
    if await name_taken(db, Permission.id, Permission.name, payload.name):
        raise HTTPException(status_code=409, detail="Permission name already exists.")
    perm = Permission(name=payload.name, description=payload.description)
    db.add(perm)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Permission name already exists."
        ) from None
    await db.refresh(perm)
    return PermissionRead.model_validate(perm)


@router.get("/permissions/{permission_id}", response_model=PermissionRead)
async def get_permission(
    permission_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
) -> PermissionRead:
    perm = await _get_permission_or_404(db, permission_id)
    return PermissionRead.model_validate(perm)


@router.patch("/permissions/{permission_id}", response_model=PermissionRead)
async def update_permission(
    permission_id: uuid.UUID,
    payload: PermissionUpdate,
    db: AsyncSession = Depends(get_session),
) -> PermissionRead:
    perm = await _get_permission_or_404(db, permission_id)
    data = payload.model_dump(exclude_unset=True)
    if (
        "name" in data
        and data["name"]
        and await name_taken(
            db, Permission.id, Permission.name, data["name"], exclude_id=perm.id
        )
    ):
        raise HTTPException(status_code=409, detail="Permission name already exists.")
    for key, value in data.items():
        setattr(perm, key, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Permission name already exists."
        ) from None
    await db.refresh(perm)
    return PermissionRead.model_validate(perm)


@router.delete("/permissions/{permission_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_permission(
    permission_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
) -> Response:
    perm = await _get_permission_or_404(db, permission_id)
    await db.delete(perm)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- roles ---------------------------------------------------------------


@router.get("/roles", response_model=list[RoleRead])
async def list_roles(db: AsyncSession = Depends(get_session)) -> list[RoleRead]:
    result = await db.execute(select(Role).order_by(Role.name))
    roles = list(result.scalars().all())
    perm_map = await _load_role_permission_map(db, [r.id for r in roles])
    return [_serialize_role(r, perm_map.get(r.id, [])) for r in roles]


@router.post("/roles", response_model=RoleRead, status_code=status.HTTP_201_CREATED)
async def create_role(
    payload: RoleCreate,
    db: AsyncSession = Depends(get_session),
) -> RoleRead:
    if payload.template_id is not None and payload.permission_ids is not None:
        raise HTTPException(
            status_code=400,
            detail="Provide either template_id or permission_ids, not both.",
        )

    if await name_taken(db, Role.id, Role.name, payload.name):
        raise HTTPException(status_code=409, detail="Role name already exists.")

    permission_ids: list[uuid.UUID] = []
    if payload.template_id is not None:
        template = await _get_role_or_404(db, payload.template_id)
        template_perms = await _load_role_permission_map(db, [template.id])
        permission_ids = template_perms.get(template.id, [])
    elif payload.permission_ids is not None:
        permission_ids = await _validate_permission_ids(db, payload.permission_ids)

    role = Role(name=payload.name, description=payload.description)
    db.add(role)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Role name already exists."
        ) from None

    for pid in permission_ids:
        db.add(RolePermission(role_id=role.id, permission_id=pid))
    await db.commit()
    await db.refresh(role)
    return _serialize_role(role, permission_ids)


@router.get("/roles/{role_id}", response_model=RoleRead)
async def get_role(
    role_id: uuid.UUID, db: AsyncSession = Depends(get_session)
) -> RoleRead:
    role = await _get_role_or_404(db, role_id)
    perm_map = await _load_role_permission_map(db, [role.id])
    return _serialize_role(role, perm_map.get(role.id, []))


@router.patch("/roles/{role_id}", response_model=RoleRead)
async def update_role(
    role_id: uuid.UUID,
    payload: RoleUpdate,
    db: AsyncSession = Depends(get_session),
) -> RoleRead:
    # SELECT … FOR UPDATE serializes concurrent writes to the same role so
    # racing PATCHes (e.g. duplicated clicks) don't collide on the
    # role_permissions primary key when one deletes and re-inserts before the
    # other commits.
    locked = await db.execute(select(Role).where(Role.id == role_id).with_for_update())
    role = locked.scalar_one_or_none()
    if role is None:
        raise HTTPException(status_code=404, detail="Role not found.")

    data = payload.model_dump(exclude_unset=True)

    new_permission_ids: list[uuid.UUID] | None = None
    if "permission_ids" in data:
        # Explicit `null` means "no change"; explicit `[]` means "clear all".
        raw = data.pop("permission_ids")
        if raw is not None:
            new_permission_ids = await _validate_permission_ids(db, raw)

    if (
        "name" in data
        and data["name"]
        and await name_taken(db, Role.id, Role.name, data["name"], exclude_id=role.id)
    ):
        raise HTTPException(status_code=409, detail="Role name already exists.")

    for key, value in data.items():
        setattr(role, key, value)

    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Role name already exists."
        ) from None

    if new_permission_ids is not None:
        await db.execute(
            delete(RolePermission).where(RolePermission.role_id == role.id)
        )
        for pid in new_permission_ids:
            db.add(RolePermission(role_id=role.id, permission_id=pid))

    # onupdate=func.now() only fires when a column on the row changes — force
    # the bump when only the join-table associations were touched.
    if not data and new_permission_ids is not None:
        role.updated_at = func.now()

    await db.commit()
    await db.refresh(role)
    if new_permission_ids is None:
        perm_map = await _load_role_permission_map(db, [role.id])
        new_permission_ids = perm_map.get(role.id, [])
    return _serialize_role(role, new_permission_ids)


@router.delete("/roles/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_role(
    role_id: uuid.UUID, db: AsyncSession = Depends(get_session)
) -> Response:
    role = await _get_role_or_404(db, role_id)
    await db.delete(role)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----- users (admin view) --------------------------------------------------


@router.get("/users", response_model=list[RbacUserRead])
async def list_users(
    db: AsyncSession = Depends(get_session),
) -> list[RbacUserRead]:
    result = await db.execute(select(User).order_by(User.username))
    users = list(result.scalars().all())
    role_map = await _load_user_role_map(db, [u.id for u in users])
    return [_serialize_user(u, role_map.get(u.id, [])) for u in users]


@router.post("/users", response_model=RbacUserRead, status_code=status.HTTP_201_CREATED)
async def create_user(
    payload: RbacUserCreate,
    db: AsyncSession = Depends(get_session),
) -> RbacUserRead:
    if await name_taken(db, User.id, User.username, payload.username):
        raise HTTPException(status_code=409, detail="Username already exists.")
    user = User(username=payload.username)
    db.add(user)
    try:
        await db.flush()
        await add_user_to_default_league(db, user.id)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Username already exists."
        ) from None
    await db.refresh(user)
    return _serialize_user(user, [])


@router.get("/users/{user_id}", response_model=RbacUserRead)
async def get_user(
    user_id: uuid.UUID, db: AsyncSession = Depends(get_session)
) -> RbacUserRead:
    user = await _get_user_or_404(db, user_id)
    role_map = await _load_user_role_map(db, [user.id])
    return _serialize_user(user, role_map.get(user.id, []))


@router.put("/users/{user_id}/roles", response_model=RbacUserRead)
async def set_user_roles(
    user_id: uuid.UUID,
    payload: RbacUserRolesUpdate,
    db: AsyncSession = Depends(get_session),
) -> RbacUserRead:
    # FOR UPDATE on the user row prevents racing PUTs from colliding on the
    # user_roles primary key (delete-then-insert otherwise conflicts).
    locked = await db.execute(select(User).where(User.id == user_id).with_for_update())
    user = locked.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    role_ids = await _validate_role_ids(db, payload.role_ids)
    await db.execute(delete(UserRole).where(UserRole.user_id == user.id))
    for rid in role_ids:
        db.add(UserRole(user_id=user.id, role_id=rid))
    await db.commit()
    return _serialize_user(user, role_ids)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> Response:
    if user_id == current_user.id:
        # Defense in depth — the UI also disables this button. Without this
        # guard, the workspace can be locked out by deleting the last admin.
        raise HTTPException(
            status_code=400, detail="You cannot delete your own account."
        )
    user = await _get_user_or_404(db, user_id)
    await db.delete(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                "This user has activity (matches, results, or tournaments) "
                "and cannot be deleted."
            ),
        ) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
