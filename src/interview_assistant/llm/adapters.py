import os
from dotenv import load_dotenv
from pydantic_ai.models import OpenAIModel
from pydantic_ai.providers import OpenAIProvider

load_dotenv()

model = OpenAIModel(
    "gpt-4o-mini",
    provider=OpenAIProvider(
        api_key=os.getenv("OPENAI_API_KEY"),
    ),
)
