# Generated by Django 4.1.13 on 2024-03-19 14:02

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import posthog.models.utils


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("posthog", "0397_projects_backfill"),
        ("ee", "0016_rolemembership_organization_member"),
    ]

    operations = [
        migrations.CreateModel(
            name="AccessControl",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=posthog.models.utils.UUIDT, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("resource", models.CharField(max_length=32)),
                ("access_level", models.CharField(max_length=32)),
                ("resource_id", models.CharField(max_length=36, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL
                    ),
                ),
                (
                    "organization_member",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="access_controls",
                        related_query_name="access_controls",
                        to="posthog.organizationmembership",
                    ),
                ),
                (
                    "role",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="access_controls",
                        related_query_name="access_controls",
                        to="ee.role",
                    ),
                ),
                (
                    "team",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="access_controls",
                        related_query_name="access_controls",
                        to="posthog.team",
                    ),
                ),
            ],
        ),
        migrations.AddConstraint(
            model_name="accesscontrol",
            constraint=models.UniqueConstraint(
                fields=("resource", "resource_id", "team", "organization_member", "role"),
                name="unique resource per target",
            ),
        ),
    ]
