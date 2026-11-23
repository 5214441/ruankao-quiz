"""无需联网的回归测试：真实公告格式、时间变更、关联去重。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_tenders import candidate_from_parts, parse_deadline, parse_opening_time
from notice_upgrade import revised_times, attach_change_notices, match_original
from monitor_huoqiu import snapshot_times, find_time_updates


class NoticeUpgradeTests(unittest.TestCase):
    def test_opening_time_revision(self):
        text = "原开标时间：2026年12月7日09时00分，现更正为2026年12月14日09时30分。"
        got = revised_times(text, parse_deadline, parse_opening_time)
        self.assertEqual(got["openingTime"], "2026-12-14T09:30:00+08:00")

    def test_deadline_revision(self):
        text = "原投标文件递交截止时间2026年12月7日09时00分，现调整为2026年12月14日10时00分。"
        got = revised_times(text, parse_deadline, parse_opening_time)
        self.assertEqual(got["deadline"], "2026-12-14T10:00:00+08:00")

    def test_unknown_time_must_not_be_guessed(self):
        self.assertEqual(revised_times("本项目交易时间变更至2026年11月27日，具体时间请见交易文件", parse_deadline, parse_opening_time), {})
        self.assertEqual(revised_times("原开标时间2026年12月7日09时00分，其余内容不变", parse_deadline, parse_opening_time), {})

    def test_source_categories(self):
        samples = [
            ("001001003", "工程建设澄清变更"),
            ("001002002", "政府采购澄清变更"),
            ("001005002", "其他交易变更"),
        ]
        for code, typ in samples:
            with self.subTest(code=code):
                url = f"https://ggzy.luan.gov.cn/jyxxparentDetail.html?infoid=abc123&categorynum={code}"
                candidate = candidate_from_parts(url, "某县2026年道路项目澄清公告", "〖霍邱县〗2026-11-23 某县2026年道路项目澄清公告", "https://ggzy.luan.gov.cn/")
                self.assertIsNotNone(candidate)
                self.assertEqual(candidate["noticeKind"], "change")
                self.assertEqual(candidate["noticeType"], typ)
        nonentry = candidate_from_parts(
            "https://ggzy.luan.gov.cn/jyxx/001008/001008005/20261123/test.html",
            "霍邱县县道改造项目变更公告",
            "〖霍邱县〗霍邱县县道改造项目变更公告",
            "https://ggzy.luan.gov.cn/",
        )
        self.assertEqual(nonentry["noticeKind"], "change")

    def test_change_attached_and_idempotent(self):
        original = {
            "id": "original1", "title": "霍邱县农村道路维修项目招标公告",
            "region": "霍邱县", "projectCode": "E341522001005999",
            "deadline": "2026-12-07T09:00:00+08:00",
            "openingTime": "2026-12-07T09:00:00+08:00",
            "publishDate": "2026-11-02",
        }
        change = {
            "id": "notice1", "title": "关于霍邱县农村道路维修项目澄清公告",
            "region": "霍邱县", "projectCode": "E341522001005999",
            "noticeKind": "change", "publishDate": "2026-11-23",
            "url": "https://ggzy.luan.gov.cn/a",
            "revisedTimes": {"openingTime": "2026-12-14T09:30:00+08:00"},
        }
        projects = [original, change]
        self.assertEqual(attach_change_notices(projects), 1)
        self.assertEqual(original["openingTime"], "2026-12-14T09:30:00+08:00")
        self.assertEqual(change["relatedProjectId"], "original1")
        self.assertEqual(len(original["changeNotices"]), 1)
        self.assertEqual(attach_change_notices(projects), 0)
        self.assertEqual(len(original["changeNotices"]), 1)

    def test_unmatched_change_kept_without_overwriting(self):
        original = {"id": "orig", "title": "项目A", "region": "霍邱县", "projectCode": "E341522001005999"}
        change = {"id": "chg", "title": "项目B", "region": "金安区", "projectCode": "E341522001009999",
                  "noticeKind": "change", "publishDate": "2026-11-23",
                  "revisedTimes": {"openingTime": "2026-12-14T09:30:00+08:00"}}
        self.assertIsNone(match_original(change, [original, change]))
        self.assertEqual(attach_change_notices([original, change]), 0)
        self.assertNotIn("openingTime", original)

    def test_time_field_updates_detected(self):
        projects = [{"id": "a", "noticeKind": "original", "deadline": "2026-12-15T09:00:00+08:00", "openingTime": None}]
        snap = snapshot_times(projects)
        self.assertFalse(find_time_updates(projects, snap, set()))
        projects[0]["openingTime"] = "2026-12-15T09:00:00+08:00"
        self.assertEqual(len(find_time_updates(projects, snap, set())), 1)
        self.assertFalse(find_time_updates(projects, snap, {"a"}))


if __name__ == "__main__":
    unittest.main()
