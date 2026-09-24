set windows-shell := ["cmd.exe", "/c"]

dev:
    uv run fastapi dev src\main.py

typecheck:
    ty check src

format:
    ruff format src

lint:
    ruff check src --fix

migration message:
    uv run alembic revision --autogenerate -m "{{message}}"

migrate:
    uv run alembic upgrade head

migration-down:
    uv run alembic downgrade -1

migration-current:
    uv run alembic current

migration-history:
    uv run alembic history