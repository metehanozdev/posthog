# Generated by Django 4.2.15 on 2024-10-24 11:17

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0495_alter_batchexportbackfill_start_at_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="team",
            name="person_processing_opt_out",
            field=models.BooleanField(default=False, null=True),
        ),
    ]
