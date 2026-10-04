#pragma once
#include <cstddef>
#include <cstdint>

namespace openlaunch {
// Stream JSON without allocating a second complete body on a small board.
template <typename Client>
class HttpBodyWriter {
 public:
  explicit HttpBodyWriter(Client& client) : client_(client) {}
  std::size_t write(std::uint8_t byte) {
    if (!ok_) return 0;
    buffer_[used_++] = byte;
    if (used_ == sizeof(buffer_) && !flush()) return 0;
    return 1;
  }
  std::size_t write(const std::uint8_t* data, std::size_t size) {
    std::size_t written = 0;
    while (written < size && write(data[written])) ++written;
    return written;
  }
  bool flush() {
    if (!ok_) return false;
    std::size_t offset = 0;
    while (offset < used_) {
      const std::size_t sent = client_.write(buffer_ + offset, used_ - offset);
      if (sent == 0 || sent > used_ - offset) { ok_ = false; return false; }
      offset += sent;
    }
    used_ = 0;
    return true;
  }
 private:
  Client& client_;
  std::uint8_t buffer_[256] = {};
  std::size_t used_ = 0;
  bool ok_ = true;
};
}
