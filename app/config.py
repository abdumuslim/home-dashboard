from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Qingping
    qp_app_key: str = ""
    qp_app_secret: str = ""

    # Ambient Weather
    aw_api_key: str = ""
    aw_app_key: str = ""

    # Database
    database_url: str = "postgresql://postgres@localhost:5432/home"


settings = Settings()
