from functools import cached_property
from typing import Optional

from sentry_sdk import capture_exception
import structlog
from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.utils import timezone
from django_deprecate_fields import deprecate_field
from rest_framework.exceptions import ValidationError

from posthog.logging.timing import timed
from posthog.models.dashboard import Dashboard
from posthog.models.filters.utils import get_filter
from posthog.models.utils import sane_repr
from posthog.utils import absolute_uri, generate_cache_key, generate_short_id

logger = structlog.get_logger(__name__)


class InsightManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().exclude(deleted=True)


class Insight(models.Model):
    """
    Stores saved insights along with their entire configuration options. Saved insights can be stored as standalone
    reports or part of a dashboard.
    """

    name = models.CharField(max_length=400, null=True, blank=True)
    derived_name = models.CharField(max_length=400, null=True, blank=True)
    description = models.CharField(max_length=400, null=True, blank=True)
    team = models.ForeignKey("Team", on_delete=models.CASCADE)
    filters = models.JSONField(default=dict)
    filters_hash = models.CharField(max_length=400, null=True, blank=True)
    query = models.JSONField(null=True, blank=True)
    order = models.IntegerField(null=True, blank=True)
    deleted = models.BooleanField(default=False)
    saved = models.BooleanField(default=False)
    created_at = models.DateTimeField(null=True, blank=True, auto_now_add=True)
    refreshing = models.BooleanField(default=False)
    created_by = models.ForeignKey("User", on_delete=models.SET_NULL, null=True, blank=True)
    # Indicates if it's a sample graph generated by dashboard templates
    is_sample = models.BooleanField(default=False)
    # Unique ID per team for easy sharing and short links
    short_id = models.CharField(max_length=12, blank=True, default=generate_short_id)
    favorited = models.BooleanField(default=False)
    refresh_attempt = models.IntegerField(null=True, blank=True)
    last_modified_at = models.DateTimeField(default=timezone.now)
    last_modified_by = models.ForeignKey(
        "User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="modified_insights",
    )

    # DEPRECATED: using the new "dashboards" relation instead
    dashboard = models.ForeignKey(
        "Dashboard",
        related_name="items",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
    )
    # DEPRECATED: within cached results package now
    last_refresh = models.DateTimeField(blank=True, null=True)
    # DEPRECATED: on dashboard_insight now
    layouts = models.JSONField(default=dict)
    # DEPRECATED: on dashboard_insight now
    color = models.CharField(max_length=400, null=True, blank=True)
    # DEPRECATED: dive dashboards were never shipped
    dive_dashboard = models.ForeignKey("Dashboard", on_delete=models.SET_NULL, null=True, blank=True)
    # DEPRECATED: in practically all cases field `last_modified_at` should be used instead
    updated_at = models.DateTimeField(auto_now=True)
    # DEPRECATED: use `display` property of the Filter object instead
    type = deprecate_field(models.CharField(max_length=400, null=True, blank=True))
    # DEPRECATED: we don't store funnels as a separate model any more
    funnel = deprecate_field(models.IntegerField(null=True, blank=True))
    # DEPRECATED: now using app-wide tagging model. See EnterpriseTaggedItem
    deprecated_tags: ArrayField = ArrayField(models.CharField(max_length=32), null=True, blank=True, default=list)
    # DEPRECATED: now using app-wide tagging model. See EnterpriseTaggedItem
    deprecated_tags_v2: ArrayField = ArrayField(
        models.CharField(max_length=32),
        null=True,
        blank=True,
        default=None,
        db_column="tags",
    )

    # Changing these fields materially alters the Insight, so these count for the "last_modified_*" fields
    MATERIAL_INSIGHT_FIELDS = {"name", "description", "filters"}

    __repr__ = sane_repr("team_id", "id", "short_id", "name")

    objects = InsightManager()
    objects_including_soft_deleted = models.Manager()

    class Meta:
        db_table = "posthog_dashboarditem"
        unique_together = ("team", "short_id")

    def __str__(self):
        return self.name or self.derived_name or self.short_id

    @property
    def is_sharing_enabled(self):
        # uses .all and not .first so that prefetching can be used
        sharing_configurations = self.sharingconfiguration_set.all()
        return sharing_configurations[0].enabled if sharing_configurations and sharing_configurations[0] else False

    @property
    def caching_state(self):
        # uses .all and not .first so that prefetching can be used
        for state in self.caching_states.all():
            if state.dashboard_tile_id is None:
                return state
        return None

    @cached_property
    def query_from_filters(self):
        from posthog.hogql_queries.legacy_compatibility.filter_to_query import filter_to_query

        try:
            return {"kind": "InsightVizNode", "source": filter_to_query(self.filters).model_dump(), "full": True}
        except Exception as e:
            capture_exception(e)

    def dashboard_filters(
        self, dashboard: Optional[Dashboard] = None, dashboard_filters_override: Optional[dict] = None
    ):
        # query date range is set in a different function, see dashboard_query
        if dashboard and not self.query:
            dashboard_filters = {
                **(dashboard_filters_override if dashboard_filters_override is not None else dashboard.filters)
            }
            dashboard_properties = dashboard_filters.pop("properties") if dashboard_filters.get("properties") else None
            insight_date_from = self.filters.get("date_from", None)
            insight_date_to = self.filters.get("date_to", None)
            dashboard_date_from = dashboard_filters.get("date_from", None)
            dashboard_date_to = dashboard_filters.get("date_to", None)

            filters = {
                **self.filters,
                **dashboard_filters,
            }

            if dashboard_date_from is None:
                filters["date_from"] = insight_date_from
                filters["date_to"] = insight_date_to
            else:
                filters["date_from"] = dashboard_date_from
                filters["date_to"] = dashboard_date_to

            if dashboard_date_from == "all" and filters.get("compare", None) is True:
                filters["compare"] = None

            if dashboard_properties:
                if isinstance(self.filters.get("properties"), list):
                    filters["properties"] = {
                        "type": "AND",
                        "values": [
                            {"type": "AND", "values": self.filters["properties"]},
                            {"type": "AND", "values": dashboard_properties},
                        ],
                    }
                elif not self.filters.get("properties"):
                    filters["properties"] = dashboard_properties
                elif self.filters.get("properties").get("type"):
                    filters["properties"] = {
                        "type": "AND",
                        "values": [
                            self.filters["properties"],
                            {"type": "AND", "values": dashboard_properties},
                        ],
                    }
                else:
                    raise ValidationError("Unrecognized property format: ", self.filters["properties"])
            elif self.filters.get("properties"):
                filters["properties"] = self.filters.get("properties")

            return filters
        else:
            return self.filters

    def get_effective_query(
        self, *, dashboard: Optional[Dashboard], dashboard_filters_override: Optional[dict] = None
    ) -> Optional[dict]:
        from posthog.hogql_queries.apply_dashboard_filters import apply_dashboard_filters_to_dict

        if not dashboard or not self.query:
            return self.query

        return apply_dashboard_filters_to_dict(
            self.query,
            dashboard_filters_override if dashboard_filters_override is not None else dashboard.filters,
            self.team,
        )

    @property
    def url(self):
        return absolute_uri(f"/insights/{self.short_id}")


class InsightViewed(models.Model):
    class Meta:
        constraints = [models.UniqueConstraint(fields=["team", "user", "insight"], name="posthog_unique_insightviewed")]
        indexes = [models.Index(fields=["team_id", "user_id", "-last_viewed_at"])]

    # To track views from shared insights, team and user can be null
    team = models.ForeignKey("Team", on_delete=models.CASCADE, null=True, blank=True)
    user = models.ForeignKey("User", on_delete=models.CASCADE, null=True, blank=True)

    insight: models.ForeignKey = models.ForeignKey(Insight, on_delete=models.CASCADE)
    last_viewed_at: models.DateTimeField = models.DateTimeField()


@timed("generate_insight_cache_key")
def generate_insight_filters_hash(insight: Insight, dashboard: Optional[Dashboard]) -> str:
    try:
        dashboard_insight_filter = get_filter(data=insight.dashboard_filters(dashboard=dashboard), team=insight.team)
        candidate_filters_hash = generate_cache_key("{}_{}".format(dashboard_insight_filter.toJSON(), insight.team_id))
        return candidate_filters_hash
    except Exception as e:
        logger.error(
            "insight.generate_insight_cache_key.failed",
            insight_id=insight.id,
            dashboard_id="none" if not dashboard else dashboard.id,
            exception=e,
            exc_info=True,
        )
        raise
