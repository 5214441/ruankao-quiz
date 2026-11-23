"""竞争情报数据采集的可重复自动测试：不访问外网、不使用演示数据充当生产统计。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from collect import (
    allowed_url, canonical, kind_for_url, get_candidates,
    parse_page, parse_quotes, money_yuan, combine,
)

URL = "https://ggzy.luan.gov.cn/jyxx/001001/001001012/20261123/test.html"
RESULT = "https://ggzy.luan.gov.cn/jyxx/001001/001001005/20261124/result.html"
HTML = """
<html><body><h3>霍邱县城市道路施工招标</h3>
<table>
<tr><th>项目编号</th><td>E341522001005099</td><th>信息来源</th><td>六安市公共资源交易中心霍邱县分中心</td></tr>
<tr><th>标段（包）编号</th><td>E341522001005099001</td><th>标段（包）名称</th><td>霍邱县城市道路施工一标段</td></tr>
<tr><th>项目所在地</th><td>霍邱县城关镇</td><th>开标时间</th><td>2026-11-23 09:00:00</td></tr>
</table>
<h3>开标记录信息</h3>
<table><tr><th>序号</th><th>投标人</th><th>投标报价</th><th>单位</th></tr>
<tr><td>1</td><td>安徽某建筑公司</td><td>1250000.60</td><td>元</td></tr>
<tr><td>2</td><td>安徽某施工公司;安徽某安装公司</td><td>123.45</td><td>万元</td></tr>
<tr><td>3</td><td>未公布价格的投标单位</td><td>0.000000</td><td>元</td></tr>
<tr><td>4</td><td>费率报价供应商</td><td>93.20</td><td>%</td></tr></table>
</body></html>"""
RESULT_HTML = """
<html><body><h3>霍邱县城市道路施工中标结果</h3>
<table>
<tr><th>项目编号</th><td>E341522001005099</td><th>信息来源</th><td>六安市公共资源交易中心霍邱县分中心</td></tr>
<tr><th>标段（包）编号</th><td>E341522001005099001</td><th>标段（包）名称</th><td>霍邱县城市道路施工一标段</td></tr>
<tr><th>中标人</th><td>安徽某建筑公司</td><th>中标金额</th><td>1250000.60元</td></tr>
</table></body></html>"""

class CollectTests(unittest.TestCase):
    def test_verified_category(self):
        self.assertEqual(kind_for_url(URL), "opening")
        self.assertEqual(kind_for_url(RESULT), "result")
        self.assertIsNone(kind_for_url("https://ggzy.luan.gov.cn/jyxx/001001/001001002/20261123/foo.html"))
        self.assertFalse(allowed_url("http://ggzy.luan.gov.cn/foo"))
        self.assertFalse(allowed_url("https://evil.example.com/foo"))
        self.assertEqual(canonical("https://evil.example.com/a"), "")
        self.assertEqual(canonical("https://ggzy.luan.gov.cn/jyxx/001001/001001002/20261123/foo.html"), "")

    def test_public_opening_quotes_and_amount_units(self):
        page = parse_page(HTML, URL)
        self.assertEqual(page["region"], "霍邱县")
        self.assertEqual(page["kind"], "opening")
        self.assertEqual(page["projectCode"], "E341522001005099")
        self.assertEqual(page["segmentCode"], "E341522001005099001")
        self.assertEqual(len(page["quotes"]), 4)
        self.assertEqual(page["quotes"][0]["bidYuan"], 1250000.6)
        self.assertEqual(page["quotes"][1]["bidYuan"], 1234500.0)
        self.assertIsNone(page["quotes"][2]["bidYuan"])
        self.assertIsNone(page["quotes"][3]["bidYuan"])
        self.assertEqual(page["quotes"][2]["quoteStatus"], "unverified")

    def test_invalid_quotes_never_become_valid(self):
        for value, unit in [("0", "元"), ("9.5", "%"), ("—", "元"), ("询价", "元")]:
            self.assertIsNone(money_yuan(value, unit))
        self.assertEqual(money_yuan("12.50万元"), 125000)

    def test_match_result_only_exact_project_and_segment(self):
        a=parse_page(HTML, URL)
        b=parse_page(RESULT_HTML, RESULT)
        combined=combine([a,b])
        opening=next(p for p in combined["projects"] if p["kind"]=="opening")
        self.assertEqual(opening["winner"], "安徽某建筑公司")
        self.assertEqual(combined["companies"][0]["wins"] + combined["companies"][1]["wins"] + combined["companies"][2]["wins"] + combined["companies"][3]["wins"], 1)
        diff=parse_page(RESULT_HTML.replace("001005099001", "001005099002"), RESULT)
        distinct=combine([a,diff])
        other_open=next(p for p in distinct["projects"] if p["kind"]=="opening")
        self.assertFalse(other_open.get("winner"))

    def test_raw_quote_joint_venture_not_split(self):
        quotes=parse_quotes(__import__("bs4").BeautifulSoup(HTML,"html.parser"))
        joint=[q for q in quotes if ";" in q["bidder"]]
        self.assertEqual(len(joint), 1)

    def test_nonentry_official_award_fields(self):
        html = """
        <html><body><h3>霍邱县乌龙派出所综合业务用房建设项目中标结果公示</h3>
        <table>
          <tr><th>交易项目名称</th><td>霍邱县乌龙派出所综合业务用房建设项目</td></tr>
          <tr><th>交易项目编号</th><td>HXJY1110001064859</td></tr>
          <tr><th>项目所在地</th><td>霍邱县乌龙镇</td></tr>
          <tr><th>成交单位</th><td>安徽联天建设工程有限公司</td><th>成交价</th><td>2261862.38元</td></tr>
        </table></body></html>"""
        url = "https://ggzy.luan.gov.cn/jyxx/001008/001008002/20261102/8ab89e93-61c0-4681-8385-2d38b38c5716.html"
        record = parse_page(html, url)
        self.assertEqual(record["region"], "霍邱县")
        self.assertEqual(record["winner"], "安徽联天建设工程有限公司")
        self.assertEqual(record["winningYuan"], 2261862.38)

    def test_candidates_only_official_types(self):
        html='<a href="/jyxx/001001/001001012/20261123/a.html">开标</a><a href="/jyxx/001001/001001002/20261123/b.html">招标</a>'
        self.assertEqual(list(get_candidates(html,"https://ggzy.luan.gov.cn/")), [
            "https://ggzy.luan.gov.cn/jyxx/001001/001001012/20261123/a.html"
        ])

if __name__ == "__main__":
    unittest.main()
