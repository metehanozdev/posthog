# Generated by Django 4.2.15 on 2024-10-31 15:34

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0507_alter_externaldatasource_source_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="project",
            name="product_description",
            field=models.TextField(blank=True, max_length=1000, null=True),
        ),
    ]
