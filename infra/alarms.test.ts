import { describe, expect, test } from "bun:test";
import {
  getAlb5xxAlarm,
  getAlbResponseTimeAlarm,
  getAlbUnhealthyHostAlarm,
  getEcsCpuAlarm,
  getEcsMemoryAlarm,
  getEcsRunningTaskAlarm,
  getNodeHeartbeatAlarm,
  getRedisEvictionAlarm,
  getRedisMemoryAlarm,
  getSnsTopicName,
  NODE_HEARTBEAT_METRIC,
  NODE_HEARTBEAT_NAMESPACE,
} from "./alarms";

describe("getSnsTopicName", () => {
  test("includes stage in topic name", () => {
    expect(getSnsTopicName("production")).toBe("sandchest-alarms-production");
    expect(getSnsTopicName("dev")).toBe("sandchest-alarms-dev");
  });
});

describe("getEcsRunningTaskAlarm", () => {
  test("production threshold matches minimum task count", () => {
    expect(getEcsRunningTaskAlarm("production").threshold).toBe(2);
  });

  test("dev threshold allows single task", () => {
    expect(getEcsRunningTaskAlarm("dev").threshold).toBe(1);
  });

  test("uses ECS namespace", () => {
    expect(getEcsRunningTaskAlarm("production").namespace).toBe("AWS/ECS");
  });

  test("tracks RunningTaskCount metric", () => {
    expect(getEcsRunningTaskAlarm("production").metricName).toBe(
      "RunningTaskCount",
    );
  });

  test("alarms when below threshold", () => {
    expect(getEcsRunningTaskAlarm("production").comparisonOperator).toBe(
      "LessThanThreshold",
    );
  });

  test("treats missing data as breaching", () => {
    expect(getEcsRunningTaskAlarm("production").treatMissingData).toBe(
      "breaching",
    );
  });

  test("evaluates over 2 consecutive 1-minute periods", () => {
    expect(getEcsRunningTaskAlarm("production").period).toBe(60);
    expect(getEcsRunningTaskAlarm("production").evaluationPeriods).toBe(2);
  });
});

describe("getEcsCpuAlarm", () => {
  test("production threshold is 85%", () => {
    expect(getEcsCpuAlarm("production").threshold).toBe(85);
  });

  test("dev threshold is 90%", () => {
    expect(getEcsCpuAlarm("dev").threshold).toBe(90);
  });

  test("uses average statistic over 5-minute periods", () => {
    expect(getEcsCpuAlarm("production").statistic).toBe("Average");
    expect(getEcsCpuAlarm("production").period).toBe(300);
  });

  test("evaluates over 3 consecutive periods", () => {
    expect(getEcsCpuAlarm("production").evaluationPeriods).toBe(3);
  });
});

describe("getEcsMemoryAlarm", () => {
  test("production threshold is 85%", () => {
    expect(getEcsMemoryAlarm("production").threshold).toBe(85);
  });

  test("dev threshold is 90%", () => {
    expect(getEcsMemoryAlarm("dev").threshold).toBe(90);
  });

  test("tracks MemoryUtilization metric", () => {
    expect(getEcsMemoryAlarm("production").metricName).toBe(
      "MemoryUtilization",
    );
  });

  test("uses average statistic over 5-minute periods", () => {
    expect(getEcsMemoryAlarm("production").statistic).toBe("Average");
    expect(getEcsMemoryAlarm("production").period).toBe(300);
  });
});

describe("getAlb5xxAlarm", () => {
  test("production threshold is 10 errors per period", () => {
    expect(getAlb5xxAlarm("production").threshold).toBe(10);
  });

  test("dev threshold is 50 errors per period", () => {
    expect(getAlb5xxAlarm("dev").threshold).toBe(50);
  });

  test("uses ALB namespace", () => {
    expect(getAlb5xxAlarm("production").namespace).toBe(
      "AWS/ApplicationELB",
    );
  });

  test("uses Sum statistic", () => {
    expect(getAlb5xxAlarm("production").statistic).toBe("Sum");
  });

  test("evaluates over 2 consecutive 5-minute periods", () => {
    expect(getAlb5xxAlarm("production").period).toBe(300);
    expect(getAlb5xxAlarm("production").evaluationPeriods).toBe(2);
  });

  test("treats missing data as not breaching", () => {
    expect(getAlb5xxAlarm("production").treatMissingData).toBe("notBreaching");
  });
});

describe("getAlbResponseTimeAlarm", () => {
  test("production threshold is 2 seconds", () => {
    expect(getAlbResponseTimeAlarm("production").threshold).toBe(2);
  });

  test("dev threshold is 5 seconds", () => {
    expect(getAlbResponseTimeAlarm("dev").threshold).toBe(5);
  });

  test("tracks TargetResponseTime metric", () => {
    expect(getAlbResponseTimeAlarm("production").metricName).toBe(
      "TargetResponseTime",
    );
  });

  test("evaluates over 3 consecutive periods", () => {
    expect(getAlbResponseTimeAlarm("production").evaluationPeriods).toBe(3);
  });
});

describe("getAlbUnhealthyHostAlarm", () => {
  test("threshold is 0 for all stages", () => {
    expect(getAlbUnhealthyHostAlarm().threshold).toBe(0);
  });

  test("uses Maximum statistic", () => {
    expect(getAlbUnhealthyHostAlarm().statistic).toBe("Maximum");
  });

  test("evaluates over 2 consecutive 1-minute periods", () => {
    expect(getAlbUnhealthyHostAlarm().period).toBe(60);
    expect(getAlbUnhealthyHostAlarm().evaluationPeriods).toBe(2);
  });

  test("alarms when any unhealthy hosts exist", () => {
    expect(getAlbUnhealthyHostAlarm().comparisonOperator).toBe(
      "GreaterThanThreshold",
    );
  });
});

describe("getRedisMemoryAlarm", () => {
  test("production threshold is 80%", () => {
    expect(getRedisMemoryAlarm("production").threshold).toBe(80);
  });

  test("dev threshold is 90%", () => {
    expect(getRedisMemoryAlarm("dev").threshold).toBe(90);
  });

  test("uses ElastiCache namespace", () => {
    expect(getRedisMemoryAlarm("production").namespace).toBe(
      "AWS/ElastiCache",
    );
  });

  test("tracks DatabaseMemoryUsagePercentage metric", () => {
    expect(getRedisMemoryAlarm("production").metricName).toBe(
      "DatabaseMemoryUsagePercentage",
    );
  });

  test("evaluates over 3 consecutive 5-minute periods", () => {
    expect(getRedisMemoryAlarm("production").period).toBe(300);
    expect(getRedisMemoryAlarm("production").evaluationPeriods).toBe(3);
  });
});

describe("getRedisEvictionAlarm", () => {
  test("production threshold is 0 evictions", () => {
    expect(getRedisEvictionAlarm("production").threshold).toBe(0);
  });

  test("dev threshold allows some evictions", () => {
    expect(getRedisEvictionAlarm("dev").threshold).toBe(100);
  });

  test("uses Sum statistic", () => {
    expect(getRedisEvictionAlarm("production").statistic).toBe("Sum");
  });
});

describe("getNodeHeartbeatAlarm", () => {
  test("uses custom Sandchest namespace", () => {
    expect(getNodeHeartbeatAlarm().namespace).toBe(NODE_HEARTBEAT_NAMESPACE);
    expect(getNodeHeartbeatAlarm().namespace).toBe("Sandchest/Node");
  });

  test("tracks Heartbeat metric", () => {
    expect(getNodeHeartbeatAlarm().metricName).toBe(NODE_HEARTBEAT_METRIC);
    expect(getNodeHeartbeatAlarm().metricName).toBe("Heartbeat");
  });

  test("alarms when no heartbeats received", () => {
    expect(getNodeHeartbeatAlarm().comparisonOperator).toBe(
      "LessThanOrEqualToThreshold",
    );
    expect(getNodeHeartbeatAlarm().threshold).toBe(0);
  });

  test("treats missing data as breaching", () => {
    expect(getNodeHeartbeatAlarm().treatMissingData).toBe("breaching");
  });

  test("evaluates over 3 consecutive 1-minute periods", () => {
    expect(getNodeHeartbeatAlarm().period).toBe(60);
    expect(getNodeHeartbeatAlarm().evaluationPeriods).toBe(3);
  });

  test("uses SampleCount statistic", () => {
    expect(getNodeHeartbeatAlarm().statistic).toBe("SampleCount");
  });
});
