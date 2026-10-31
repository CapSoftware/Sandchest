package com.acme;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
class UserController {
  @GetMapping("/{id}")
  public String show(@PathVariable String id) throws Exception {
    return jdbc.queryForObject("SELECT name FROM users WHERE id = " + id, String.class);
  }
}
