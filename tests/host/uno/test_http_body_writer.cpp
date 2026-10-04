#include <cassert>
#include <string>
#include <algorithm>
#include "../../../firmware/uno-r4-wifi/openlaunch/HttpBodyWriter.h"

struct Client {
  std::string output;
  std::size_t maximum = 7;
  std::size_t failAfter = 100000;
  std::size_t write(const std::uint8_t* data, std::size_t size) {
    if (output.size() >= failAfter) return 0;
    const std::size_t count = std::min(size, std::min(maximum, failAfter - output.size()));
    output.append(reinterpret_cast<const char*>(data), count);
    return count;
  }
};
int main() {
  const std::string body(3840, 'x');
  Client client;
  openlaunch::HttpBodyWriter<Client> writer(client);
  assert(writer.write(reinterpret_cast<const std::uint8_t*>(body.data()), body.size()) == body.size());
  assert(writer.flush());
  assert(writer.flush());
  assert(client.output == body);
  Client failing;
  failing.failAfter = 100;
  openlaunch::HttpBodyWriter<Client> failed(failing);
  assert(failed.write(reinterpret_cast<const std::uint8_t*>(body.data()), body.size()) < body.size());
  assert(!failed.flush());
  assert(failed.write('x') == 0);
  assert(failing.output.size() == 100);
}
