# Generated by Django 4.2.15 on 2024-10-10 12:47

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0485_alter_datawarehousesavedquery_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="cohort",
            name="last_error_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
