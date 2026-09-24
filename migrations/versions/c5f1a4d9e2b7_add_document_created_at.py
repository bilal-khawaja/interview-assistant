"""Add created_at to documents.

Revision ID: c5f1a4d9e2b7
Revises: 85bd13811e48
Create Date: 2026-09-15

"""
from typing import Sequence, Union

from alembic import op


revision: str = "c5f1a4d9e2b7"
down_revision: Union[str, Sequence[str], None] = "85bd13811e48"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE document
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE
        DEFAULT CURRENT_TIMESTAMP NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE document DROP COLUMN IF EXISTS created_at")
