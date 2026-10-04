import importlib.util
import unittest
import json
spec = importlib.util.spec_from_file_location('provision', 'scripts/provision-uno.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
class ProvisionTests(unittest.TestCase):
    def test_valid(self):
        data = json.loads(p.make_payload('https://devices.example.com', '0'*64, 'test', 'fixture', 'a'*64))
        self.assertEqual(data['host'], 'devices.example.com')
    def test_invalid(self):
        for origin in ['http://devices.example.com','https://x.example:8443','https://u:p@x.example','https://x.example/path']:
            with self.assertRaises(ValueError): p.make_payload(origin, '0'*64, 'test', 'fixture', 'a'*64)
        with self.assertRaises(ValueError): p.make_payload('https://x.example', 'bad', 'test', 'fixture', 'a'*64)
        with self.assertRaises(ValueError): p.make_payload('https://x.example', '0'*64, 'x'*33, 'fixture', 'a'*64)
if __name__ == '__main__': unittest.main()
