from django.db import migrations


NEGATIVE_SEQUENCE_PERSON_DISTINCTID_SQL = (
    "ALTER SEQUENCE posthog_persondistinctid_id_seq NO MINVALUE START WITH -1 INCREMENT -1 RESTART;"
)


class Migration(migrations.Migration):
    dependencies = [
        ("posthog", "0313_early_access_feature"),
    ]

    operations = [
        migrations.RunSQL(
            NEGATIVE_SEQUENCE_PERSON_DISTINCTID_SQL,
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
