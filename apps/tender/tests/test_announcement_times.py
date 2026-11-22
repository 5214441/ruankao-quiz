"""Regression tests for announcement opening and submission times."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_tenders import parse_deadline, parse_opening_time, parse_detail_text


class NoticeTimeTests(unittest.TestCase):
    def test_explicit_opening_without_deadline(self):
        text = "十六、项目开标时间：2026年7月8日9时00分"
        self.assertEqual(parse_opening_time(text), "2026-07-08T09:00:00+08:00")
        self.assertIsNone(parse_deadline(text))

    def test_dash_date_and_clock_seconds(self):
        text = "6. 开标时间及地点\n6.1 开标时间：2026-5 - 12 09:00:00。"
        self.assertEqual(parse_opening_time(text), "2026-05-12T09:00:00+08:00")

    def test_response_opening(self):
        text = "五、响应文件开启\n1、时间：2026年11月30日9点30分（北京时间）"
        self.assertEqual(parse_opening_time(text), "2026-11-30T09:30:00+08:00")

    def test_combined_opening_and_submission(self):
        text = "四、投标文件递交截止时间、开标时间和地点\n1、时间：2025年7月11日9点00分"
        expected = "2025-07-11T09:00:00+08:00"
        self.assertEqual(parse_deadline(text), expected)
        self.assertEqual(parse_opening_time(text), expected)

    def test_stated_same_time(self):
        text = "开标时间与投标文件递交截止时间为同一时间即2026年7月8日9时00分"
        expected = "2026-07-08T09:00:00+08:00"
        self.assertEqual(parse_deadline(text), expected)
        self.assertEqual(parse_opening_time(text), expected)

    def test_distinct_times(self):
        text = (
            "四、响应文件提交\n1、截止时间：2026年02月26日09点30分\n"
            "五、响应文件开启\n1、时间：2026年02月27日09点30分"
        )
        result = parse_detail_text(text)
        self.assertEqual(result["deadline"], "2026-02-26T09:30:00+08:00")
        self.assertEqual(result["openingTime"], "2026-02-27T09:30:00+08:00")

    def test_only_deadline(self):
        text = "投标截止时间：2026年11月23日09时30分。"
        self.assertEqual(parse_deadline(text), "2026-11-23T09:30:00+08:00")
        self.assertIsNone(parse_opening_time(text))

    def test_procedural_guidance_is_not_opening(self):
        text = "开标时间前使用CA数字证书登录，公告日期：2026年11月17日16:15"
        self.assertIsNone(parse_opening_time(text))

    def test_invalid_date_rejected(self):
        text = "开标时间：2026年02月31日09:30"
        self.assertIsNone(parse_opening_time(text))


if __name__ == "__main__":
    unittest.main()
