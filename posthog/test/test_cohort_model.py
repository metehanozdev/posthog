from unittest.mock import patch

import pytest

from ee.clickhouse.client import sync_execute
from posthog.models import Action, ActionStep, Cohort, Event, Person, Team
from posthog.test.base import BaseTest


class TestCohort(BaseTest):
    def test_insert_by_distinct_id_or_email(self):
        Person.objects.create(team=self.team, distinct_ids=["000"])
        Person.objects.create(team=self.team, distinct_ids=["123"])
        Person.objects.create(team=self.team)
        # Team leakage
        team2 = Team.objects.create(organization=self.organization)
        Person.objects.create(team=team2, distinct_ids=["123"])

        cohort = Cohort.objects.create(team=self.team, groups=[], is_static=True)
        cohort.insert_users_by_list(["a header or something", "123", "000", "email@example.org"])
        cohort = Cohort.objects.get()
        self.assertEqual(cohort.people.count(), 2)
        self.assertEqual(cohort.is_calculating, False)

        #  If we accidentally call calculate_people it shouldn't erase people
        cohort.calculate_people()
        self.assertEqual(cohort.people.count(), 2)

        # if we add people again, don't increase the number of people in cohort
        cohort.insert_users_by_list(["123"])
        cohort = Cohort.objects.get()
        self.assertEqual(cohort.people.count(), 2)
        self.assertEqual(cohort.is_calculating, False)

    @pytest.mark.ee
    def test_calculating_cohort_clickhouse(self):
        person1 = Person.objects.create(
            distinct_ids=["person1"], team_id=self.team.pk, properties={"$some_prop": "something"}
        )
        person2 = Person.objects.create(distinct_ids=["person2"], team_id=self.team.pk, properties={})
        person3 = Person.objects.create(
            distinct_ids=["person3"], team_id=self.team.pk, properties={"$some_prop": "something"}
        )
        cohort = Cohort.objects.create(
            team=self.team, groups=[{"properties": {"$some_prop": "something"}}], name="cohort1",
        )

        cohort.calculate_people_ch()
        self.assertCountEqual(list(cohort.people.all()), [person1, person3])

        uuids = [row[0] for row in sync_execute("SELECT person_id FROM cohortpeople")]
        self.assertCountEqual(uuids, [person1.uuid, person3.uuid])

    def test_empty_query(self):
        cohort2 = Cohort.objects.create(
            team=self.team, groups=[{"properties": {"$some_prop": "nomatchihope"}}], name="cohort1",
        )

        cohort2.calculate_people()
        self.assertFalse(Cohort.objects.get().is_calculating)
